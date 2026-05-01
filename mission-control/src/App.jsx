import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Settings, Video, Search, Link2, RefreshCw } from 'lucide-react';

const API_URL = import.meta.env.VITE_COORDINATOR_API_URL || 'http://localhost:3000/api';

function App() {
  const [videos, setVideos] = useState([]);
  const [settings, setSettings] = useState({ search_keywords: '', discord_webhook_url: '' });
  const [manualUrl, setManualUrl] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [videosRes, settingsRes] = await Promise.all([
        axios.get(`${API_URL}/videos`),
        axios.get(`${API_URL}/settings`)
      ]);
      setVideos(videosRes.data);
      setSettings(settingsRes.data);
    } catch (err) {
      console.error("Failed to fetch data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!manualUrl) return;
    try {
      await axios.post(`${API_URL}/videos/manual`, { youtube_url: manualUrl });
      setManualUrl('');
      fetchData();
    } catch (err) {
      alert("Error adding manual URL");
    }
  };

  const handleSettingsSave = async (e) => {
    e.preventDefault();
    try {
      await axios.post(`${API_URL}/settings`, settings);
      alert("Settings saved!");
    } catch (err) {
      alert("Error saving settings");
    }
  };

  const getStatusColor = (status) => {
    switch(status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'processing': return 'bg-blue-100 text-blue-800';
      case 'failed': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800'; // pending
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto space-y-8">

        {/* Header */}
        <header className="flex justify-between items-center bg-white p-6 rounded-lg shadow-sm border border-gray-100">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
              <Video className="w-8 h-8 text-blue-600" />
              Mission Control
            </h1>
            <p className="text-gray-500 mt-1">YouTube-to-TikTok Auto Clipping Farm</p>
          </div>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

          {/* Main Content - Videos */}
          <div className="md:col-span-2 space-y-8">
            {/* Manual Input */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Link2 className="w-5 h-5" />
                Manual Video Submission
              </h2>
              <form onSubmit={handleManualSubmit} className="flex gap-4">
                <input
                  type="url"
                  value={manualUrl}
                  onChange={e => setManualUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
                <button
                  type="submit"
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
                >
                  Process
                </button>
              </form>
            </div>

            {/* Video Queue */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Video className="w-5 h-5" />
                Processing Queue
              </h2>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500 text-sm uppercase tracking-wider">
                      <th className="pb-3 font-medium">YouTube ID</th>
                      <th className="pb-3 font-medium">Status</th>
                      <th className="pb-3 font-medium">Added</th>
                      <th className="pb-3 font-medium">Retries</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-700">
                    {videos.length === 0 ? (
                      <tr>
                        <td colSpan="4" className="py-8 text-center text-gray-500">
                          No videos in queue
                        </td>
                      </tr>
                    ) : (
                      videos.map(v => (
                        <tr key={v.youtube_id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                          <td className="py-3">
                            <a href={`https://youtube.com/watch?v=${v.youtube_id}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                              {v.youtube_id}
                            </a>
                          </td>
                          <td className="py-3">
                            <span className={`px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide ${getStatusColor(v.status)}`}>
                              {v.status}
                            </span>
                          </td>
                          <td className="py-3 text-sm">{new Date(v.date_processed).toLocaleString()}</td>
                          <td className="py-3 text-sm">{v.retries}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sidebar - Settings */}
          <div className="md:col-span-1">
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100 sticky top-8">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Farm Settings
              </h2>
              <form onSubmit={handleSettingsSave} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Search className="w-4 h-4" />
                    Base Search Keyword
                  </label>
                  <input
                    type="text"
                    value={settings.search_keywords || ''}
                    onChange={e => setSettings({...settings, search_keywords: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    placeholder="e.g. funny podcast moments"
                  />
                  <p className="text-xs text-gray-500 mt-1">Used by Ollama to generate varied queries.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Discord Webhook URL
                  </label>
                  <input
                    type="url"
                    value={settings.discord_webhook_url || ''}
                    onChange={e => setSettings({...settings, discord_webhook_url: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    placeholder="https://discord.com/api/webhooks/..."
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 bg-gray-900 hover:bg-black text-white font-medium rounded-md transition-colors mt-4"
                >
                  Save Settings
                </button>
              </form>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export default App;
