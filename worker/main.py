import os
import json
import uuid
import asyncio
import subprocess
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import List
import requests
from dotenv import load_dotenv

# Load env variables
load_dotenv()

app = FastAPI(title="AI Worker Node")

OLLAMA_API_URL = os.getenv("OLLAMA_API_URL", "http://localhost:11434")
SHARED_OUTPUT_DIR = os.getenv("SHARED_OUTPUT_DIR", "/tmp/sharedclips")

os.makedirs(SHARED_OUTPUT_DIR, exist_ok=True)
TEMP_WORK_DIR = "/tmp/worker_jobs"
os.makedirs(TEMP_WORK_DIR, exist_ok=True)

class ProcessVideoRequest(BaseModel):
    youtube_url: str
    video_id: str  # Useful for database updates or filenames
    webhook_url: str = None

class GenerateQueriesRequest(BaseModel):
    base_topic: str

def download_video(youtube_url: str, output_path_base: str):
    """Downloads video and audio using yt-dlp."""
    cmd = [
        "yt-dlp",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "-o", f"{output_path_base}.%(ext)s",
        youtube_url
    ]
    subprocess.run(cmd, check=True)
    return f"{output_path_base}.mp4"

def transcribe_audio(video_path: str, output_dir: str, output_base: str):
    """Runs Whisper to transcribe audio and generate SRT."""
    import whisper
    from whisper.utils import get_writer

    model = whisper.load_model("base") # Use small/medium/large depending on VRAM
    result = model.transcribe(video_path, word_timestamps=True)

    # Save SRT
    srt_writer = get_writer("srt", output_dir)
    srt_writer(result, output_base)

    return result, f"{os.path.join(output_dir, output_base)}.srt"

def get_highlights_from_ollama(transcript_text: str):
    """Passes transcript to Ollama to get 3 viral segments."""
    prompt = f"""
    You are an expert content curator for TikTok. Read the following video transcript.
    Find the 3 most viral, engaging, emotional, or humorous segments that are between 30 and 60 seconds long.
    Output ONLY a JSON array of objects with 'start' and 'end' keys (representing seconds as floats). No other text.

    Transcript:
    {transcript_text[:15000]} # Limit to avoid context window issues
    """

    response = requests.post(
        f"{OLLAMA_API_URL}/api/generate",
        json={
            "model": "llama3",
            "prompt": prompt,
            "stream": False,
            "format": "json"
        }
    )

    if response.status_code == 200:
        data = response.json()
        try:
            return json.loads(data["response"])
        except json.JSONDecodeError:
            print("Failed to parse Ollama output as JSON")
            return []
    else:
        print("Failed to communicate with Ollama")
        return []

def calculate_dynamic_crop(video_path: str, start_time: float, end_time: float):
    """Uses OpenCV to find the face and calculate a 9:16 crop."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Target aspect ratio 9:16
    target_width = int(height * 9 / 16)
    target_height = height

    # Start at the segment start time
    cap.set(cv2.CAP_PROP_POS_MSEC, start_time * 1000)

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

    # We will sample a few frames to find the average face position
    faces_x = []

    frames_to_check = 10
    step = int((end_time - start_time) * fps / frames_to_check)
    if step <= 0:
        step = 1

    for i in range(frames_to_check):
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        if len(faces) > 0:
            # Take the first face
            x, y, w, h = faces[0]
            center_x = x + w / 2
            faces_x.append(center_x)

        # skip frames
        current_frame = cap.get(cv2.CAP_PROP_POS_FRAMES)
        cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame + step)

    cap.release()

    if faces_x:
        avg_x = sum(faces_x) / len(faces_x)
    else:
        avg_x = width / 2

    # Calculate crop x ensuring it stays within bounds
    crop_x = int(avg_x - target_width / 2)
    crop_x = max(0, min(crop_x, width - target_width))

    return crop_x, 0, target_width, target_height

def shift_srt_timestamps(srt_path: str, output_srt_path: str, shift_seconds: float):
    """Reads an SRT file, shifts all timestamps by `-shift_seconds`, and saves it."""
    import re
    from datetime import datetime, timedelta

    def parse_time(time_str):
        return datetime.strptime(time_str, '%H:%M:%S,%f')

    def format_time(dt):
        return dt.strftime('%H:%M:%S,%f')[:-3]

    with open(srt_path, 'r', encoding='utf-8') as f:
        content = f.read()

    blocks = content.strip().split('\n\n')
    new_blocks = []

    for block in blocks:
        lines = block.split('\n')
        if len(lines) >= 3:
            idx = lines[0]
            times = lines[1]
            text = '\n'.join(lines[2:])

            match = re.match(r'(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})', times)
            if match:
                start_str, end_str = match.groups()
                start_dt = parse_time(start_str)
                end_dt = parse_time(end_str)

                shift_td = timedelta(seconds=shift_seconds)
                base_dt = parse_time("00:00:00,000")

                # Shift backwards
                new_start_dt = start_dt - shift_td
                new_end_dt = end_dt - shift_td

                # If the entire subtitle is before 0, drop it
                if new_end_dt < base_dt:
                    continue

                # Clamp start time to 0
                if new_start_dt < base_dt:
                    new_start_dt = base_dt

                new_times = f"{format_time(new_start_dt)} --> {format_time(new_end_dt)}"
                new_blocks.append(f"{idx}\n{new_times}\n{text}")

    with open(output_srt_path, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(new_blocks))

def send_webhook(webhook_url: str, video_id: str, status: str, error: str = None):
    if not webhook_url:
        return
    payload = {"video_id": video_id, "status": status}
    if error:
        payload["error"] = error
    try:
        requests.post(webhook_url, json=payload)
    except Exception as e:
        print(f"Failed to send webhook: {e}")

def process_video_task(youtube_url: str, video_id: str, webhook_url: str = None):
    """Background task to process the video."""
    import shutil
    job_dir = os.path.join(TEMP_WORK_DIR, video_id)
    try:
        print(f"Starting processing for {video_id} ({youtube_url})")
        os.makedirs(job_dir, exist_ok=True)

        base_name = f"video_{video_id}"
        video_path_base = os.path.join(job_dir, base_name)

        # 1. Download
        video_path = download_video(youtube_url, video_path_base)
        print("Download complete.")

        # 2. Transcribe
        result, srt_path = transcribe_audio(video_path, job_dir, base_name)
        print("Transcription complete.")

        # 3. Get Highlights
        transcript_text = result["text"]
        segments = get_highlights_from_ollama(transcript_text)
        print(f"Got {len(segments)} segments from Ollama.")

        # 4. Crop & Render each segment
        for i, segment in enumerate(segments):
            start_time = segment.get("start", 0)
            end_time = segment.get("end", 0)
            duration = end_time - start_time

            if duration <= 0:
                continue

            crop_x, crop_y, crop_w, crop_h = calculate_dynamic_crop(video_path, start_time, end_time)

            output_file = os.path.join(SHARED_OUTPUT_DIR, f"{video_id}_clip_{i+1}.mp4")

            # 5. FFmpeg command
            # Escape path for filter
            # srt_path_escaped = srt_path.replace("\\", "/").replace(":", "\\:")

            # We use absolute paths. For burn in, we might need special escaping depending on OS.
            # Using simple ffmpeg execution

            import ffmpeg

            # Due to ffmpeg-python limitations with complex filters and nvenc, sometimes it's easier to use subprocess
            # Subtitle fix: shift subtitles back by start_time
            shifted_srt_path = os.path.join(job_dir, f"shifted_{i}.srt")
            shift_srt_timestamps(srt_path, shifted_srt_path, start_time)

            import ffmpeg

            # We use ffmpeg-python as required.
            # We must escape the subtitle path properly for the filter if it contains special chars (usually windows, but linux is mostly fine)
            escaped_srt = shifted_srt_path.replace('\\', '/').replace(':', '\\\\:')

            stream = ffmpeg.input(video_path, ss=start_time, t=duration)

            # Video stream processing: crop -> subtitles
            v_stream = stream.video.filter('crop', crop_w, crop_h, crop_x, crop_y).filter('subtitles', escaped_srt)

            # Audio stream
            a_stream = stream.audio

            # Output
            out = ffmpeg.output(
                v_stream,
                a_stream,
                output_file,
                vcodec='h264_nvenc',
                preset='p6',
                cq=20,
                acodec='aac',
                y=None # overwrite
            )

            ffmpeg.run(out, quiet=True)
            print(f"Rendered clip {i+1} to {output_file}")

        print(f"Finished processing video {video_id}")
        send_webhook(webhook_url, video_id, "completed")

    except Exception as e:
        print(f"Error processing video {video_id}: {e}")
        send_webhook(webhook_url, video_id, "failed", str(e))

    finally:
        # Clean up temporary files
        if os.path.exists(job_dir):
            try:
                shutil.rmtree(job_dir)
                print(f"Cleaned up temporary directory: {job_dir}")
            except Exception as e:
                print(f"Failed to clean up {job_dir}: {e}")

@app.post("/process_video")
async def process_video(req: ProcessVideoRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(process_video_task, req.youtube_url, req.video_id, req.webhook_url)
    return {"status": "accepted", "message": f"Processing started for {req.video_id}"}

@app.post("/generate_queries")
async def generate_queries(req: GenerateQueriesRequest):
    prompt = f"""
    You are an expert TikTok content strategist. I want to find viral YouTube videos related to this base topic: "{req.base_topic}".
    Generate exactly 5 varied, high-potential YouTube search queries that will return engaging, long-form videos suitable for clipping into TikToks.
    Output ONLY a JSON array of 5 strings. No markdown formatting, no other text.
    """

    response = requests.post(
        f"{OLLAMA_API_URL}/api/generate",
        json={
            "model": "llama3",
            "prompt": prompt,
            "stream": False,
            "format": "json"
        }
    )

    if response.status_code == 200:
        try:
            data = response.json()
            queries = json.loads(data["response"])
            if isinstance(queries, list):
                return {"queries": queries}
            else:
                return {"queries": []}
        except Exception as e:
            raise HTTPException(status_code=500, detail="Failed to parse Ollama response")
    else:
        raise HTTPException(status_code=response.status_code, detail="Ollama API error")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
