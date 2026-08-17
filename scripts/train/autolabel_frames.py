#!/usr/bin/env python3
"""
Auto-annotate extracted frames with Grounding DINO (open-vocabulary detector),
producing YOLO-format labels + contact sheets for human/AI visual QA.

    ~/.venvs/wayste-train/bin/python scripts/train/autolabel_frames.py \
        <frames_dir> <out_dataset_dir> [--device mps]

The "teacher labels, student trains" (distillation) pipeline:
  1. Grounding DINO is prompted with a text phrase per class and draws boxes.
     It is far too slow for the kiosk (~seconds/frame) but its annotation
     quality is more consistent than crowd-sourced human labels.
  2. Every labeled frame is composited into contact sheets under
     <out>/qa_sheets/ — REVIEW THESE BEFORE TRAINING. Frames whose best box
     falls in the "uncertain" band land in qa_sheets/uncertain/ and are
     excluded from the dataset unless --keep-uncertain is passed.
  3. Output is a ready-to-train YOLO dataset (train/valid split by video so
     near-duplicate neighboring frames never straddle the split → no
     leakage-inflated validation).

Class prompts map to the 5-class demo vocabulary of
scripts/train/train_demo_yolo.py — keep CLASSES in the same order.
"""

import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

import cv2

# Must match scripts/train/train_demo_yolo.py CLASSES order.
CLASSES = ["plastic_bottle", "can", "paper_cup", "plastic_cup", "battery"]

# Text prompts for the teacher model. Grounding DINO reads lowercase phrases
# separated by periods; phrasing matters more than you'd expect — "aluminum
# beverage can" outperforms bare "can", which also matches trash cans.
PROMPTS = {
    "plastic_bottle": "plastic bottle",
    "can": "aluminum beverage can",
    "paper_cup": "paper cup",
    "plastic_cup": "clear plastic cup",
    "battery": "aa battery",
}

ACCEPT_SCORE = 0.45  # ≥ this → auto-accept
REVIEW_SCORE = 0.30  # between review and accept → uncertain, human QA decides
MAX_BOXES_PER_CLASS = 2  # a demo frame holds at most a couple of one item
VALID_FRACTION = 0.2  # of VIDEOS (not frames) — split by source to avoid leakage
SHEET_COLS, SHEET_ROWS, THUMB = 5, 4, 320


def load_model(device: str):
    import torch
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    model_id = "IDEA-Research/grounding-dino-base"
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(device)
    model.eval()
    return torch, processor, model


def label_frame(torch, processor, model, device, img_rgb, class_name):
    from PIL import Image

    prompt = PROMPTS[class_name] + "."
    inputs = processor(
        images=Image.fromarray(img_rgb), text=prompt, return_tensors="pt"
    ).to(device)
    with torch.no_grad():
        outputs = model(**inputs)
    h, w = img_rgb.shape[:2]
    results = processor.post_process_grounded_object_detection(
        outputs, inputs.input_ids, threshold=REVIEW_SCORE,
        text_threshold=REVIEW_SCORE, target_sizes=[(h, w)],
    )[0]
    boxes = []
    for score, box in zip(results["scores"], results["boxes"]):
        x1, y1, x2, y2 = [float(v) for v in box]
        boxes.append((float(score), (x1, y1, x2, y2)))
    boxes.sort(reverse=True)
    return boxes[:MAX_BOXES_PER_CLASS]


def to_yolo_line(cls_id, box, w, h):
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2 / w, (y1 + y2) / 2 / h
    bw, bh = (x2 - x1) / w, (y2 - y1) / h
    return f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"


def draw_annotated_thumb(img, boxes_scored, cls_name):
    vis = img.copy()
    for score, (x1, y1, x2, y2) in boxes_scored:
        color = (0, 200, 0) if score >= ACCEPT_SCORE else (0, 160, 255)
        cv2.rectangle(vis, (int(x1), int(y1)), (int(x2), int(y2)), color, 3)
        cv2.putText(vis, f"{cls_name} {score:.2f}", (int(x1), max(20, int(y1) - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    scale = THUMB / max(vis.shape[:2])
    return cv2.resize(vis, (int(vis.shape[1] * scale), int(vis.shape[0] * scale)))


def write_sheets(thumbs, out_dir, prefix):
    out_dir.mkdir(parents=True, exist_ok=True)
    per_sheet = SHEET_COLS * SHEET_ROWS
    import numpy as np

    for i in range(0, len(thumbs), per_sheet):
        chunk = thumbs[i : i + per_sheet]
        cell_h = max(t.shape[0] for t in chunk)
        cell_w = max(t.shape[1] for t in chunk)
        rows_n = (len(chunk) + SHEET_COLS - 1) // SHEET_COLS
        sheet = np.zeros((rows_n * cell_h, SHEET_COLS * cell_w, 3), dtype=np.uint8)
        for j, t in enumerate(chunk):
            r, c = divmod(j, SHEET_COLS)
            sheet[r * cell_h : r * cell_h + t.shape[0], c * cell_w : c * cell_w + t.shape[1]] = t
        cv2.imwrite(str(out_dir / f"{prefix}_{i // per_sheet:03d}.jpg"), sheet,
                    [cv2.IMWRITE_JPEG_QUALITY, 85])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", help="directory of frames; subdirectory name OR filename prefix must identify the class (e.g. plastic_bottle/... or plastic_bottle_xxx.jpg). Use 'negative' for empty-background frames.")
    ap.add_argument("out", help="output YOLO dataset directory")
    ap.add_argument("--device", default="mps", choices=["mps", "cpu", "cuda"])
    ap.add_argument("--keep-uncertain", action="store_true")
    args = ap.parse_args()

    frames_dir = Path(args.frames).expanduser()
    out = Path(args.out).expanduser()
    images = sorted(
        p for p in frames_dir.rglob("*.jpg") if "qa_sheets" not in p.parts
    )
    if not images:
        sys.exit(f"No .jpg frames under {frames_dir}")

    def frame_class(p: Path):
        candidates = [p.parent.name, p.name]
        for c in candidates:
            if c.startswith("negative"):
                return "negative"
            for cls in CLASSES:
                if c.startswith(cls):
                    return cls
        return None

    grouped = defaultdict(list)
    unknown = []
    for p in images:
        cls = frame_class(p)
        (grouped[cls] if cls else unknown).append(p)
    if unknown:
        print(f"WARNING: {len(unknown)} frames match no class prefix — skipped")
        for p in unknown[:5]:
            print("   e.g.", p)

    print(f"Loading Grounding DINO on {args.device}…")
    torch, processor, model = load_model(args.device)

    # Split by SOURCE VIDEO: neighboring frames are near-duplicates, and
    # letting them straddle train/valid inflates validation into a memory
    # test — the exact failure the dataset audit exists to catch.
    def video_stem(p: Path):
        return p.stem.rsplit("_f", 1)[0]

    stems = sorted({video_stem(p) for p in images})
    rng = random.Random(42)
    valid_stems = set(rng.sample(stems, max(1, round(len(stems) * VALID_FRACTION)))) if len(stems) > 1 else set()

    stats = defaultdict(lambda: [0, 0, 0])  # class -> [accepted, uncertain, empty]
    sidecar = {}
    thumbs_ok, thumbs_unc = defaultdict(list), defaultdict(list)

    for split in ("train", "valid"):
        (out / split / "images").mkdir(parents=True, exist_ok=True)
        (out / split / "labels").mkdir(parents=True, exist_ok=True)

    for cls, paths in sorted(grouped.items()):
        for p in paths:
            split = "valid" if video_stem(p) in valid_stems else "train"
            img = cv2.imread(str(p))
            if img is None:
                continue
            h, w = img.shape[:2]

            if cls == "negative":
                cv2.imwrite(str(out / split / "images" / p.name), img)
                (out / split / "labels" / f"{p.stem}.txt").write_text("")
                stats[cls][0] += 1
                continue

            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            boxes = label_frame(torch, processor, model, args.device, rgb, cls)
            best = boxes[0][0] if boxes else 0.0
            accepted = [b for b in boxes if b[0] >= ACCEPT_SCORE]

            if accepted:
                cls_id = CLASSES.index(cls)
                lines = [to_yolo_line(cls_id, b, w, h) for _, b in accepted]
                cv2.imwrite(str(out / split / "images" / p.name), img)
                (out / split / "labels" / f"{p.stem}.txt").write_text("\n".join(lines) + "\n")
                sidecar[p.name] = {"class": cls, "scores": [round(s, 3) for s, _ in accepted], "split": split}
                stats[cls][0] += 1
                thumbs_ok[cls].append(draw_annotated_thumb(img, accepted, cls))
            elif best >= REVIEW_SCORE:
                stats[cls][1] += 1
                thumbs_unc[cls].append(draw_annotated_thumb(img, boxes, cls))
                if args.keep_uncertain:
                    cls_id = CLASSES.index(cls)
                    lines = [to_yolo_line(cls_id, b, w, h) for _, b in boxes[:1]]
                    cv2.imwrite(str(out / split / "images" / p.name), img)
                    (out / split / "labels" / f"{p.stem}.txt").write_text("\n".join(lines) + "\n")
            else:
                stats[cls][2] += 1

    for cls, ts in thumbs_ok.items():
        write_sheets(ts, out / "qa_sheets", f"{cls}_accepted")
    for cls, ts in thumbs_unc.items():
        write_sheets(ts, out / "qa_sheets" / "uncertain", f"{cls}_uncertain")

    (out / "autolabel_report.json").write_text(json.dumps(
        {"stats": {k: {"accepted": v[0], "uncertain": v[1], "no_detection": v[2]} for k, v in stats.items()},
         "valid_videos": sorted(valid_stems), "sidecar": sidecar}, indent=2))

    (out / "data.yaml").write_text(
        "train: train/images\nval: valid/images\n"
        f"nc: {len(CLASSES)}\nnames: {CLASSES}\n")

    print("\n=== Auto-label report ===")
    for cls, (ok, unc, none) in sorted(stats.items()):
        print(f"  {cls:16s} accepted {ok:4d} | uncertain {unc:3d} | no-detection {none:3d}")
    print(f"\nQA sheets: {out / 'qa_sheets'} — review before training.")


if __name__ == "__main__":
    main()
