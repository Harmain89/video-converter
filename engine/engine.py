#!/usr/bin/env python3
"""Smart video conversion engine.

Two modes:
  python engine.py --analyze "<path>"
      -> prints one JSON object describing the file and the recommended plan.

  python engine.py --convert "<path>" --format mp4 --codec h264 --quality balanced --mode auto
      -> prints JSON-line events to stdout: {"type":"progress"...}, then "done" or "error".

Uses ffmpeg / ffprobe from PATH. Stdlib only.

The whole point: figure out the *cheapest* operation that produces a correct file.
Most "convert MKV to MP4" jobs need no re-encoding at all -- just a container remux
(`-c copy`), which finishes in seconds regardless of length. We only re-encode the
streams that are actually incompatible, and prefer Intel Quick Sync (QSV) hardware
acceleration when we do, falling back to software x264/x265 if QSV is unavailable.
"""
import argparse
import json
import os
import subprocess
import sys
import threading

# --- Container compatibility tables -----------------------------------------
# Codecs each target container can hold without re-encoding.
MP4_VIDEO_OK = {"h264", "hevc", "h265", "mpeg4", "av1", "mpeg2video"}
MP4_AUDIO_OK = {"aac", "mp3", "ac3", "eac3", "alac"}
# MKV accepts essentially anything, so remux is almost always possible.
MKV_VIDEO_OK = MP4_VIDEO_OK | {"vp8", "vp9", "theora", "mpeg1video"}
MKV_AUDIO_OK = MP4_AUDIO_OK | {"opus", "vorbis", "flac", "dts", "truehd", "pcm_s16le"}

QUALITY_TO_QSV_GQ = {"high": 20, "balanced": 23, "small": 28}
QUALITY_TO_X264_CRF = {"high": 18, "balanced": 21, "small": 26}


def emit(obj):
    """Write one JSON event as a line and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run_ffprobe(path):
    cmd = [
        "ffprobe", "-v", "error", "-of", "json",
        "-show_format", "-show_streams", path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "ffprobe failed")
    return json.loads(out.stdout)


def classify(info):
    """Pull the first video stream + all audio streams out of ffprobe output."""
    video = None
    audios = []
    subs = 0
    for s in info.get("streams", []):
        t = s.get("codec_type")
        if t == "video" and video is None and s.get("codec_name") != "mjpeg":
            video = s
        elif t == "audio":
            audios.append(s)
        elif t == "subtitle":
            subs += 1
    fmt = info.get("format", {})
    duration = float(fmt.get("duration", 0) or 0)
    size = int(fmt.get("size", 0) or 0)
    return video, audios, subs, duration, size


def decide(video, audios, fmt):
    """Decide the cheapest plan for the chosen target container.

    Returns (plan, video_action, audio_action, label) where actions are
    'copy' or 'encode'.
    """
    vok = MP4_VIDEO_OK if fmt == "mp4" else MKV_VIDEO_OK
    aok = MP4_AUDIO_OK if fmt == "mp4" else MKV_AUDIO_OK

    vcodec = (video or {}).get("codec_name", "")
    acodecs = [a.get("codec_name", "") for a in audios]

    video_compatible = vcodec in vok
    audio_compatible = all(c in aok for c in acodecs) if acodecs else True

    if video_compatible and audio_compatible:
        return "remux", "copy", "copy", "Instant remux (no quality loss)"
    if video_compatible and not audio_compatible:
        return "fast", "copy", "encode", "Fast: copy video, re-encode audio"
    return "transcode", "encode", "encode", "Re-encode video (hardware QSV)"


def analyze(path, fmt="mp4"):
    info = run_ffprobe(path)
    video, audios, subs, duration, size = classify(info)
    plan, vact, aact, label = decide(video, audios, fmt)
    return {
        "type": "analysis",
        "path": path,
        "duration": duration,
        "size": size,
        "video": {
            "codec": (video or {}).get("codec_name"),
            "width": (video or {}).get("width"),
            "height": (video or {}).get("height"),
        } if video else None,
        "audioTracks": len(audios),
        "audioCodecs": [a.get("codec_name") for a in audios],
        "subtitleTracks": subs,
        "plan": plan,
        "planLabel": label,
        "instant": plan == "remux",
    }


# --- Conversion --------------------------------------------------------------

def output_path(src, fmt):
    base = os.path.splitext(src)[0]
    out = f"{base}.{fmt}"
    if os.path.abspath(out) == os.path.abspath(src) or os.path.exists(out):
        out = f"{base} (converted).{fmt}"
    return out


def build_command(src, out, fmt, codec, quality, vact, aact, use_software=False):
    """Construct an ffmpeg command for the chosen actions."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats"]

    # Note: we deliberately do NOT force `-hwaccel qsv` decode. The QSV decoder
    # rejects many inputs (resolution/format dependent). Software decode is cheap;
    # the expensive part — encoding — still runs on the GPU via h264_qsv/hevc_qsv.
    cmd += ["-i", src]

    # Map first video + all audio; drop subtitles for mp4 (incompatible codecs).
    cmd += ["-map", "0:v:0", "-map", "0:a?"]

    # Video.
    if vact == "copy":
        cmd += ["-c:v", "copy"]
    else:
        if use_software:
            enc = "libx265" if codec == "h265" else "libx264"
            crf = QUALITY_TO_X264_CRF.get(quality, 21)
            cmd += ["-c:v", enc, "-preset", "veryfast", "-crf", str(crf)]
        else:
            enc = "hevc_qsv" if codec == "h265" else "h264_qsv"
            gq = QUALITY_TO_QSV_GQ.get(quality, 23)
            cmd += ["-c:v", enc, "-global_quality", str(gq), "-preset", "fast"]
        cmd += ["-pix_fmt", "yuv420p"]

    # Audio.
    if aact == "copy":
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "192k"]

    if fmt == "mp4":
        cmd += ["-movflags", "+faststart"]

    cmd += ["-progress", "pipe:1", out]
    return cmd


def parse_time_us(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def run_ffmpeg(cmd, duration):
    """Run ffmpeg, stream progress events, return (returncode, stderr_tail)."""
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    stderr_tail = []

    def drain_stderr():
        for line in proc.stderr:
            stderr_tail.append(line.rstrip())
            if len(stderr_tail) > 30:
                stderr_tail.pop(0)

    t = threading.Thread(target=drain_stderr, daemon=True)
    t.start()

    speed = 0.0
    for line in proc.stdout:
        line = line.strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key == "speed":
            try:
                speed = float(val.replace("x", "").strip())
            except ValueError:
                speed = 0.0
        elif key == "out_time_us":
            # Note: ffmpeg's out_time_ms is also microseconds (historical quirk),
            # so we read only out_time_us to avoid double-emitting per block.
            us = parse_time_us(val)
            if us is None or us < 0:
                continue
            secs = us / 1_000_000
            percent = min(99.9, (secs / duration * 100)) if duration > 0 else 0
            eta = ((duration - secs) / speed) if (duration > 0 and speed > 0) else None
            emit({"type": "progress", "percent": round(percent, 1),
                  "speed": speed, "eta": eta, "outSeconds": round(secs, 1)})
        elif key == "progress" and val == "end":
            emit({"type": "progress", "percent": 100, "speed": speed, "eta": 0})

    proc.wait()
    t.join(timeout=1)
    return proc.returncode, "\n".join(stderr_tail)


def convert(args):
    info = run_ffprobe(args.path)
    video, audios, subs, duration, size = classify(info)

    if args.mode == "transcode":
        vact, aact = "encode", "encode"
        plan_label = "Forced re-encode (QSV)"
    else:
        plan, vact, aact, plan_label = decide(video, audios, args.format)

    out = output_path(args.path, args.format)
    emit({"type": "start", "plan": plan_label, "output": out,
          "instant": vact == "copy" and aact == "copy"})

    used_software = False
    cmd = build_command(args.path, out, args.format, args.codec, args.quality,
                        vact, aact, use_software=False)
    rc, err = run_ffmpeg(cmd, duration)

    # If a hardware encode failed, retry once with software x264/x265.
    if rc != 0 and vact == "encode":
        emit({"type": "notice", "message": "Hardware (QSV) encode failed, retrying with software encoder..."})
        used_software = True
        cmd = build_command(args.path, out, args.format, args.codec, args.quality,
                            vact, aact, use_software=True)
        rc, err = run_ffmpeg(cmd, duration)

    if rc == 0 and os.path.exists(out):
        emit({"type": "done", "output": out, "software": used_software,
              "outputSize": os.path.getsize(out)})
    else:
        emit({"type": "error", "message": err or f"ffmpeg exited with code {rc}"})
        sys.exit(1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--analyze")
    p.add_argument("--convert")
    p.add_argument("--format", default="mp4", choices=["mp4", "mkv"])
    p.add_argument("--codec", default="h264", choices=["h264", "h265"])
    p.add_argument("--quality", default="balanced", choices=["high", "balanced", "small"])
    p.add_argument("--mode", default="auto", choices=["auto", "transcode"])
    args = p.parse_args()

    try:
        if args.analyze:
            emit(analyze(args.analyze, args.format))
        elif args.convert:
            args.path = args.convert
            convert(args)
        else:
            emit({"type": "error", "message": "no mode given"})
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 - surface any failure to the UI
        emit({"type": "error", "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
