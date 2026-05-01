require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('better-sqlite3');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WORKER_API_URL = process.env.WORKER_API_URL || 'http://localhost:8000';
const COORDINATOR_URL = process.env.COORDINATOR_URL || `http://localhost:${PORT}`;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SHARED_OUTPUT_DIR = process.env.SHARED_OUTPUT_DIR || '/tmp/sharedclips';

// Database setup
const db = new sqlite3(path.join(__dirname, 'database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    youtube_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    date_processed DATETIME DEFAULT CURRENT_TIMESTAMP,
    retries INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Init default settings if empty
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('search_keywords', 'funny podcast moments');
insertSetting.run('discord_webhook_url', '');
insertSetting.run('coordinator_url', COORDINATOR_URL);

// Helpers
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

async function sendDiscordNotification(message) {
  const webhookUrl = getSetting('discord_webhook_url');
  if (webhookUrl) {
    try {
      await axios.post(webhookUrl, { content: message });
    } catch (err) {
      console.error('Failed to send Discord notification', err.message);
    }
  }
}

// API Routes
app.get('/api/videos', (req, res) => {
  const videos = db.prepare('SELECT * FROM videos ORDER BY date_processed DESC').all();
  res.json(videos);
});

app.post('/api/videos/manual', async (req, res) => {
  const { youtube_url } = req.body;
  // Extract ID
  const match = youtube_url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
  if (!match) return res.status(400).json({ error: 'Invalid YouTube URL' });
  const youtube_id = match[1];

  db.prepare('INSERT OR REPLACE INTO videos (youtube_id, status) VALUES (?, ?)').run(youtube_id, 'pending');
  res.json({ message: 'Added to queue', youtube_id });
});

app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  res.json(settings.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {}));
});

app.post('/api/settings', (req, res) => {
  const { search_keywords, discord_webhook_url } = req.body;
  if (search_keywords !== undefined) setSetting('search_keywords', search_keywords);
  if (discord_webhook_url !== undefined) setSetting('discord_webhook_url', discord_webhook_url);
  res.json({ message: 'Settings updated' });
});

// Scheduler & Dispatcher
async function searchYoutube(query) {
  if (!YOUTUBE_API_KEY) {
    console.warn("No YouTube API Key set. Skipping search.");
    return [];
  }

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        videoDuration: 'long',
        maxResults: 5,
        key: YOUTUBE_API_KEY
      }
    });
    return res.data.items.map(item => item.id.videoId);
  } catch (err) {
    console.error('YouTube API error', err.message);
    return [];
  }
}

async function jobRunner() {
  console.log("Running hourly job...");
  const baseKeyword = getSetting('search_keywords');

  if (!baseKeyword) return;

  try {
    // 1. Generate queries
    const workerRes = await axios.post(`${WORKER_API_URL}/generate_queries`, { base_topic: baseKeyword });
    const queries = workerRes.data.queries || [baseKeyword];

    console.log("Generated queries:", queries);

    // 2. Search YouTube
    const newVideoIds = new Set();
    for (const query of queries) {
      const ids = await searchYoutube(query);
      ids.forEach(id => newVideoIds.add(id));
    }

    // 3. Add to DB
    const insertStmt = db.prepare('INSERT OR IGNORE INTO videos (youtube_id, status) VALUES (?, ?)');
    let added = 0;
    for (const id of newVideoIds) {
      const result = insertStmt.run(id, 'pending');
      if (result.changes > 0) added++;
    }

    console.log(`Added ${added} new videos to queue.`);
    if (added > 0) {
      await sendDiscordNotification(`Scheduled run found ${added} new videos for "${baseKeyword}"`);
    }

  } catch (err) {
    console.error("Error in job runner", err.message);
  }
}

app.post('/api/webhook', async (req, res) => {
  const { video_id, status, error } = req.body;
  if (!video_id || !status) {
    return res.status(400).json({ error: 'Missing video_id or status' });
  }

  if (status === 'completed') {
    db.prepare('UPDATE videos SET status = ? WHERE youtube_id = ?').run('completed', video_id);
    await sendDiscordNotification(`Video ${video_id} processing completed successfully!`);
  } else if (status === 'failed') {
    const video = db.prepare('SELECT retries FROM videos WHERE youtube_id = ?').get(video_id);
    if (video) {
      if (video.retries >= 3) {
         db.prepare('UPDATE videos SET status = ? WHERE youtube_id = ?').run('failed', video_id);
         await sendDiscordNotification(`Video ${video_id} failed after 3 retries. Error: ${error}`);
      } else {
         db.prepare('UPDATE videos SET status = ? WHERE youtube_id = ?').run('pending', video_id);
         await sendDiscordNotification(`Video ${video_id} processing failed (Retry ${video.retries}/3). Error: ${error}`);
      }
    }
  }

  res.json({ message: 'Webhook received' });
});

// Dispatcher (Runs every minute to check for pending jobs)
setInterval(async () => {
  const pendingVideo = db.prepare('SELECT * FROM videos WHERE status = ? LIMIT 1').get('pending');

  if (pendingVideo) {
    if (pendingVideo.retries >= 3) {
      db.prepare('UPDATE videos SET status = ? WHERE youtube_id = ?').run('failed', pendingVideo.youtube_id);
      await sendDiscordNotification(`Video ${pendingVideo.youtube_id} failed after 3 retries.`);
      return;
    }

    db.prepare('UPDATE videos SET status = ?, retries = retries + 1 WHERE youtube_id = ?').run('processing', pendingVideo.youtube_id);
    await sendDiscordNotification(`Dispatched video to Worker: https://youtube.com/watch?v=${pendingVideo.youtube_id}`);

    try {
      const webhookUrl = getSetting('coordinator_url') + '/api/webhook';
      const response = await axios.post(`${WORKER_API_URL}/process_video`, {
        youtube_url: `https://www.youtube.com/watch?v=${pendingVideo.youtube_id}`,
        video_id: pendingVideo.youtube_id,
        webhook_url: webhookUrl
      });
      console.log(`Dispatched ${pendingVideo.youtube_id} to worker.`);
    } catch (err) {
      console.error(`Worker failed to accept ${pendingVideo.youtube_id}`, err.message);
      db.prepare('UPDATE videos SET status = ? WHERE youtube_id = ?').run('pending', pendingVideo.youtube_id);
    }
  }
}, 60000); // Check every minute

// Cron job every hour
cron.schedule('0 * * * *', jobRunner);

// TikTok Publisher Stub
app.post('/api/publish/:youtube_id', async (req, res) => {
  const { youtube_id } = req.params;
  const clipPath = path.join(SHARED_OUTPUT_DIR, `${youtube_id}_clip_1.mp4`); // Example for first clip

  if (!fs.existsSync(clipPath)) {
    return res.status(404).json({ error: 'Clip not found in shared directory' });
  }

  // TODO: Integrate TikTok API
  console.log(`Publishing ${clipPath} to TikTok...`);

  res.json({ message: 'Stub: Published to TikTok successfully' });
});

app.listen(PORT, () => {
  console.log(`Coordinator API running on port ${PORT}`);
});
