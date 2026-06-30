# ⚡ Smart Video Converter

A local, good-looking video converter. **Node.js** serves the UI and orchestrates;
a **Python + FFmpeg** engine does the actual work. Built to convert files like a
VLC-only MKV into a `.mp4` that plays everywhere — **fast**, even for long movies.

## Why it's fast

1. **No upload.** It runs on your machine and reads files **directly from disk by path**,
   so a multi-GB file starts converting instantly (no slow browser upload).
2. **Smart remux.** It probes the file first. If the streams are already container-compatible
   (e.g. H.264 + AAC inside an MKV), it just **rewrites the container** with `ffmpeg -c copy` —
   finishing in **seconds for any length, with zero quality loss**. No needless re-encoding.
3. **Hardware acceleration.** When a stream genuinely must be re-encoded, it uses **Intel
   Quick Sync (QSV)** (`h264_qsv` / `hevc_qsv`), automatically falling back to software
   `libx264`/`libx265` if QSV is unavailable.
4. **Live progress.** Conversion runs as a background process; progress, speed and ETA stream
   to the browser over a WebSocket, so the UI never freezes.

## Requirements

- **Node.js** 18+ and **Python** 3.8+
- **FFmpeg** (with `ffmpeg` and `ffprobe` on your `PATH`)

## Run

```bash
npm install
npm start
```

Then open <http://localhost:3000>, browse to your video, pick it, and click **Convert**.
The output `.mp4` is written **next to the original** (the original is never modified).

Set a different port with `PORT=8080 npm start`.

## How it works

```
Browser (public/)  ──REST──►  Node server.js  ──spawn──►  Python engine/engine.py  ──►  FFmpeg
        ▲           ◄─WebSocket─ (progress) ◄──────────── (JSON progress lines) ◄─────────┘
```

- `engine.py --analyze <file>` → JSON describing codecs + the recommended plan.
- `engine.py --convert <file> --format mp4 --codec h264 --quality balanced --mode auto`
  → streams `{"type":"progress",...}` lines, then `done` / `error`.

## Options

- **Container:** MP4 (universal) or MKV (keeps subtitle tracks etc.)
- **Mode:** Auto (smart, fastest) or Force re-encode
- **Codec / Quality:** only used when re-encoding (H.264/H.265, High/Balanced/Small)
