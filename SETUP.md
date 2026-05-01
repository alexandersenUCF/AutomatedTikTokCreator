# Local YouTube-to-TikTok AI Clipping Farm Setup Guide

This project is a distributed, fully automated YouTube-to-TikTok clipping farm. It relies on a two-machine setup on a local network:
1. **The Coordinator Node**: Handles scheduling, database tracking, dispatching tasks, and the Mission Control frontend.
2. **The AI Worker Node**: Handles heavy media processing, utilizing a dedicated GPU (e.g. RTX 4060 Ti) for Whisper transcription, AI highlight detection, and NVENC encoding.

Both machines need to be connected over the same local network and use a **Shared Network Directory**.

---

## 1. Setting up the Shared Network Directory

To pass final processed videos from the Worker to the Coordinator (which handles the TikTok publishing API), we use a shared network folder.

### On the Machine Hosting the Folder (e.g., Coordinator/Windows or Linux/Samba)
1. Create a folder (e.g., `C:\SharedClips` on Windows or `/mnt/sharedclips` on Linux).
2. **Windows**: Right-click the folder -> Properties -> Sharing -> Advanced Sharing -> Share this folder. Ensure the Worker machine has Read/Write permissions.
3. **Linux**: Use Samba to share the folder:
   ```ini
   [SharedClips]
   path = /mnt/sharedclips
   writable = yes
   guest ok = yes
   ```
   Restart Samba (`sudo systemctl restart smbd`).

### On the Client Machine (e.g., Worker)
Mount the network drive so the application can access it natively.
- **Windows Client**: Map the network drive (e.g., `Z:\` -> `\\<COORDINATOR_IP>\SharedClips`).
- **Linux Client**: Use `cifs-utils` to mount it to `/mnt/sharedclips`.

---

## 2. Installing and Running Ollama

The Worker node uses local Llama 3 for intelligent query generation and highlight detection.

1. Download and install Ollama from [ollama.com](https://ollama.com).
2. Open a terminal and run the following command to download and run the Llama 3 model:
   ```bash
   ollama run llama3
   ```
3. Keep the Ollama server running. By default, it exposes a REST API at `http://localhost:11434`.

---

## 3. Configuring the `.env` Files

Each node needs specific environment variables to communicate with each other and output files to the shared network drive.

### Worker Node (`/worker/.env`)
Create a `.env` file in the `/worker` directory:

```env
# Shared network drive mount path (e.g., /mnt/sharedclips or Z:\)
SHARED_OUTPUT_DIR=/mnt/sharedclips

# Local Ollama endpoint
OLLAMA_API_URL=http://localhost:11434

# Optional: Host/Port configurations for FastAPI
WORKER_HOST=0.0.0.0
WORKER_PORT=8000
```

### Coordinator Node (`/coordinator/.env`)
Create a `.env` file in the `/coordinator` directory:

```env
# Port for the Node.js Coordinator backend
PORT=3000

# The base URL of the Worker Node on the local network
WORKER_API_URL=http://<WORKER_IP>:8000

# The base URL of this Coordinator Node (so the Worker knows where to send webhooks)
COORDINATOR_URL=http://<COORDINATOR_IP>:3000

# Your YouTube Data API v3 Key
YOUTUBE_API_KEY=your_youtube_api_key_here

# (Optional) TikTok API credentials placeholder
TIKTOK_API_KEY=your_tiktok_api_key
TIKTOK_API_SECRET=your_tiktok_api_secret

# Shared Output Directory for the Coordinator to read finished videos from
SHARED_OUTPUT_DIR=/mnt/sharedclips
```

### Mission Control Frontend (`/mission-control/.env`)
Create a `.env` file in the `/mission-control` directory:

```env
# Target the local Coordinator backend
VITE_COORDINATOR_API_URL=http://<COORDINATOR_IP>:3000
```

---

## Next Steps
- Refer to `/worker/README.md` for Python installation (requirements.txt).
- Refer to `/coordinator/README.md` for Node.js setup (npm install).
- Refer to `/mission-control/README.md` for Frontend setup (npm install && npm run dev).
