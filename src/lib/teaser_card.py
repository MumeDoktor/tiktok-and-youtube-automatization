"""Render four timed story beats over a montage of matched archive shots."""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
TEXT_WIDTH = 900
FONTS = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(px):
    for candidate in FONTS:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, px)
    return ImageFont.load_default()


def wrap(draw, text, face):
    lines = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if line and draw.textlength(candidate, font=face) > TEXT_WIDTH:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def beat_overlay(text, handle, index, count, target):
    image = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    px = 72
    face = font(px)
    lines = wrap(draw, text, face)
    while len(lines) > 3 and px > 54:
        px -= 2
        face = font(px)
        lines = wrap(draw, text, face)
    if len(lines) > 3:
        raise ValueError(f"beat {index + 1} is too long for the frame")
    line_h = int(px * 1.2)
    total_h = line_h * len(lines)
    box_top = 1390 - total_h // 2 - 32
    box_bottom = 1390 + total_h // 2 + 32
    draw.rounded_rectangle((52, box_top, W - 52, box_bottom), radius=28,
                           fill=(0, 0, 0, 178))
    y = box_top + 28
    for line in lines:
        width = draw.textlength(line, font=face)
        draw.text(((W - width) / 2, y), line, font=face,
                  fill=(255, 214, 91, 255) if index == count - 1 else (255, 255, 255, 255),
                  stroke_width=2, stroke_fill=(0, 0, 0, 255))
        y += line_h
    label_face = font(32)
    if handle:
        draw.text((66, 265), f"@{handle.lstrip('@')}", font=label_face,
                  fill=(232, 232, 232, 230))
    marker = f"{index + 1:02d} / {count:02d}"
    draw.text((W - 66 - draw.textlength(marker, font=label_face), 265), marker,
              font=label_face, fill=(232, 232, 232, 220))
    image.save(target)


def probe(ffmpeg, clip):
    ffprobe = re.sub(r"ffmpeg(\.exe)?$", lambda m: "ffprobe" + (m.group(1) or ""), ffmpeg)
    output = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
         "-of", "json", clip], capture_output=True, text=True, check=True).stdout
    info = json.loads(output)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    return int(video["width"]), int(video["height"]), float(info["format"]["duration"]), has_audio


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    with open(args.spec, encoding="utf-8") as stream:
        spec = json.load(stream)
    beats = spec.get("beats")
    beat_sec = float(spec.get("beatSec", 0))
    if not isinstance(beats, list) or len(beats) != 4 or beat_sec <= 0:
        raise ValueError("spec needs four beats and a positive beatSec")
    for i, beat in enumerate(beats):
        if not 4 <= len(str(beat).split()) <= 9:
            raise ValueError(f"beat {i + 1} needs 4-9 words")
    _, _, duration, has_audio = probe(args.ffmpeg, args.clip)
    if duration < beat_sec * len(beats) - 1:
        raise ValueError("montage is shorter than its four beats")
    with tempfile.TemporaryDirectory(prefix="story-beats-") as scratch:
        overlays = []
        for i, beat in enumerate(beats):
            overlay = os.path.join(scratch, f"beat-{i}.png")
            beat_overlay(str(beat), str(spec.get("handle") or ""), i, len(beats), overlay)
            overlays.append(overlay)
        chain = [
            "[0:v]split=2[bgsrc][fgsrc]",
            f"[bgsrc]scale={W}:{H}:force_original_aspect_ratio=increase,"
            f"crop={W}:{H},boxblur=24:3,eq=brightness=-0.16[bg]",
            f"[fgsrc]scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1[fg]",
            "[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2-80[base]",
        ]
        previous = "base"
        for i in range(len(beats)):
            next_label = f"card{i}"
            start = i * beat_sec
            end = (i + 1) * beat_sec
            chain.append(
                f"[{previous}][{i + 1}:v]overlay=0:0:"
                f"enable='gte(t,{start:.3f})*lt(t,{end:.3f})'[{next_label}]"
            )
            previous = next_label
        cmd = [args.ffmpeg, "-y", "-v", "error", "-i", args.clip]
        for overlay in overlays:
            cmd.extend(["-loop", "1", "-i", overlay])
        if not has_audio:
            cmd.extend(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"])
        cmd.extend([
            "-filter_complex", ";".join(chain), "-map", f"[{previous}]",
            "-map", "0:a:0" if has_audio else f"{len(beats) + 1}:a:0",
            "-t", f"{beat_sec * len(beats):.3f}", "-r", "30",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", args.out,
        ])
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    print(json.dumps({"ok": True, "durationSec": round(beat_sec * len(beats), 2),
                      "beats": len(beats)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(json.dumps({"ok": False, "error": (error.stderr or str(error))[-600:]}), flush=True)
        sys.exit(1)
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}), flush=True)
        sys.exit(1)
