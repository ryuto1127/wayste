#!/usr/bin/env python3
"""
Extract training frames from demo-item videos.

Usage:
    python3 scripts/train/video_to_frames.py <video_dir_or_file> <out_dir> [--fps 3] [--max-per-video 400]

Videos are the cheapest way to capture same-domain training data: 1 minute of
walking an item around in front of the actual demo camera yields hundreds of
frames with the exact lighting/background/optics the model will see on demo
day. Blurry frames (motion blur while moving the item) are skipped via a
Laplacian sharpness gate so the auto-labeler downstream doesn't waste work on
frames YOLO would never be shown crisp equivalents of.

Frame filenames embed the source video stem so provenance survives shuffling:
    <video-stem>_f000123.jpg
"""

import argparse
import sys
from pathlib import Path

import cv2

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

# Below this Laplacian variance the frame is motion-blurred beyond usefulness.
# Tuned for 1080p indoor footage; halve it if legitimate frames get skipped.
SHARPNESS_MIN = 60.0


def extract(video: Path, out_dir: Path, fps: float, max_frames: int) -> int:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        print(f"  SKIP (cannot open): {video}")
        return 0
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / fps))
    kept = idx = 0
    while kept < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sharp = cv2.Laplacian(gray, cv2.CV_64F).var()
            if sharp >= SHARPNESS_MIN:
                out = out_dir / f"{video.stem}_f{idx:06d}.jpg"
                cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                kept += 1
        idx += 1
    cap.release()
    print(f"  {video.name}: {kept} frames (of {idx} read)")
    return kept


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="video file or directory of videos")
    ap.add_argument("out", help="output directory for frames")
    ap.add_argument("--fps", type=float, default=3.0, help="frames to keep per second")
    ap.add_argument("--max-per-video", type=int, default=400)
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    videos = (
        [src]
        if src.is_file()
        else sorted(p for p in src.rglob("*") if p.suffix.lower() in VIDEO_EXTS)
    )
    if not videos:
        sys.exit(f"No videos found under {src}")

    total = sum(extract(v, out_dir, args.fps, args.max_per_video) for v in videos)
    print(f"Total: {total} frames → {out_dir}")


if __name__ == "__main__":
    main()
