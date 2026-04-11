"""
Convert reviewed pilot log data into YOLO fine-tuning dataset.

Accepts either:
  - A ZIP file from /api/review/export (contains images + metadata.jsonl)
  - A standalone JSONL file (images downloaded from URLs)

Usage:
  1. Review all entries at /review
  2. Download the export ZIP from the review page
  3. Run: python training/prepare_pilot_data.py --input review-images-2026-04-10.zip --output pilot_dataset

Output structure:
  pilot_dataset/
    images/train/         Images (80%)
    images/val/           (20%)
    labels/train/         YOLO annotation .txt files
    labels/val/
    data.yaml             Dataset config for Ultralytics
    needs_annotation/     Images without bbox (for Roboflow manual annotation)
    manifest.json         Full manifest with metadata per image
    report.txt            Summary statistics

Designed to merge with the existing TACO dataset for combined training.
Uses the same 12-class system from prepare_dataset.py.
"""

import json
import os
import random
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from collections import Counter

# ── Same 12 waste classes as prepare_dataset.py ──
CLASS_NAMES = [
    "plastic_bottle",    # 0  → recycling
    "can",               # 1  → recycling
    "paper_cup",         # 2  → landfill (lined)
    "plastic_cup",       # 3  → landfill
    "glass_bottle",      # 4  → recycling
    "cardboard",         # 5  → recycling
    "food_waste",        # 6  → compost
    "paper",             # 7  → recycling
    "plastic_bag",       # 8  → landfill
    "plastic_container", # 9  → landfill
    "battery",           # 10 → special
    "styrofoam",         # 11 → landfill
]

# COCO-80 class name → waste class ID
# Maps YOLO detections from the kiosk (COCO classes) to our 12-class system.
# Classes not in this map are flagged for manual review.
COCO_TO_WASTE_CLASS = {
    "bottle":      0,   # plastic_bottle
    "wine glass":  4,   # glass_bottle (close enough)
    "cup":         2,   # paper_cup (default; may be plastic)
    "fork":        9,   # plastic_container (utensils group)
    "knife":       9,
    "spoon":       9,
    "bowl":        9,
    "banana":      6,   # food_waste
    "apple":       6,
    "sandwich":    6,
    "orange":      6,
    "broccoli":    6,
    "carrot":      6,
    "hot dog":     6,
    "pizza":       6,
    "donut":       6,
    "cake":        6,
    "book":        7,   # paper
    "cell phone":  10,  # battery (electronics → special)
    "remote":      10,
    "keyboard":    10,
    "mouse":       10,
    "laptop":      10,
    "toothbrush":  9,   # plastic_container (small plastic)
    "backpack":    8,   # plastic_bag (fabric/plastic bag)
    "handbag":     8,
    "scissors":    10,  # battery/special (metal)
    "vase":        4,   # glass_bottle
    "teddy bear":  8,   # plastic_bag (soft items group)
}

# Waste stream → most likely waste class (for items without YOLO bbox)
# Used as a hint for annotation; the actual class must be verified manually.
STREAM_TO_LIKELY_CLASS = {
    "recycling":    0,   # plastic_bottle (most common recyclable)
    "compost":      6,   # food_waste
    "landfill":     9,   # plastic_container (generic landfill)
    "special":      10,  # battery/electronics
    "ewaste":       10,
    "needs_review": None,
}


def download_image(url: str, dest: Path, timeout: int = 15) -> bool:
    """Download image from URL. Returns True on success."""
    try:
        urllib.request.urlretrieve(url, str(dest))
        return True
    except Exception as e:
        print(f"  WARN: Failed to download {url}: {e}")
        return False


def map_coco_to_waste_class(coco_class_name: str):
    """Map COCO class name to 12-class waste ID. Returns None if no mapping."""
    return COCO_TO_WASTE_CLASS.get(coco_class_name)


def load_from_zip(zip_path: Path):
    """Extract entries and images from the review export ZIP."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="pilot_export_"))
    entries = []
    image_dir = tmp_dir / "images"
    image_dir.mkdir()

    with zipfile.ZipFile(zip_path) as zf:
        # Extract metadata.jsonl
        jsonl_data = None
        for name in zf.namelist():
            if name == "metadata.jsonl":
                jsonl_data = zf.read(name).decode("utf-8")
            elif name.lower().endswith((".jpg", ".jpeg", ".png")):
                zf.extract(name, image_dir)

        if not jsonl_data:
            print("ERROR: ZIP does not contain metadata.jsonl — was it exported from the review page?")
            sys.exit(1)

        for line_num, line in enumerate(jsonl_data.strip().split("\n"), 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                # Map imageFile to local path so we skip downloading
                if entry.get("imageFile"):
                    local_path = image_dir / entry["imageFile"]
                    # Image might be at root or nested
                    if not local_path.exists():
                        for candidate in image_dir.rglob(entry["imageFile"]):
                            local_path = candidate
                            break
                    if local_path.exists():
                        entry["_localImage"] = str(local_path)
                entries.append(entry)
            except json.JSONDecodeError as e:
                print(f"  WARN: Skipping JSONL line {line_num}: {e}")

    return entries, tmp_dir


def load_from_jsonl(jsonl_path: Path):
    """Load entries from a standalone JSONL file."""
    entries = []
    with open(jsonl_path) as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"  WARN: Skipping line {line_num}: {e}")
    return entries, None


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Prepare pilot data for YOLO fine-tuning")
    parser.add_argument("--input", required=True, help="Path to export ZIP or JSONL file")
    parser.add_argument("--output", default="pilot_dataset", help="Output directory")
    parser.add_argument("--split-ratio", type=float, default=0.8, help="Train/val split ratio")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for split")
    parser.add_argument("--skip-download", action="store_true", help="Skip image download (use existing)")
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.output)

    if not input_path.exists():
        print(f"ERROR: {input_path} not found")
        sys.exit(1)

    # ── Load input (ZIP or JSONL) ──
    tmp_dir = None
    if input_path.suffix == ".zip":
        print(f"Loading from ZIP: {input_path}")
        entries, tmp_dir = load_from_zip(input_path)
    else:
        print(f"Loading from JSONL: {input_path}")
        entries, tmp_dir = load_from_jsonl(input_path)

    print(f"Loaded {len(entries)} reviewed entries")

    # ── Categorize entries ──
    has_bbox = []         # YOLO detected + has bbox → auto-annotate
    needs_annotation = [] # No bbox → needs manual annotation in Roboflow
    false_detections = [] # False detection → negative examples
    skipped = []          # No image URL or other issues

    for entry in entries:
        verdict = entry.get("verdict")
        image_url = entry.get("imageUrl")

        if not image_url:
            skipped.append(entry)
            continue

        if verdict == "false_detection":
            false_detections.append(entry)
            continue

        yolo_dets = entry.get("yoloDetections")
        if yolo_dets and len(yolo_dets) > 0:
            has_bbox.append(entry)
        else:
            needs_annotation.append(entry)

    print(f"\nCategorization:")
    print(f"  With bbox (auto-annotate):     {len(has_bbox)}")
    print(f"  Without bbox (needs Roboflow): {len(needs_annotation)}")
    print(f"  False detections (negative):   {len(false_detections)}")
    print(f"  Skipped (no image):            {len(skipped)}")

    # ── Create directories ──
    for split in ["train", "val"]:
        (out_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / split).mkdir(parents=True, exist_ok=True)
    (out_dir / "needs_annotation").mkdir(parents=True, exist_ok=True)

    # ── Process entries with bbox ──
    print(f"\n── Processing {len(has_bbox)} entries with bbox ──")
    annotated = []
    class_counts = Counter()
    unmapped_coco = Counter()

    for i, entry in enumerate(has_bbox):
        verdict = entry["verdict"]
        correct_stream = entry.get("correctStream")
        dets = entry["yoloDetections"]

        # "wrong" verdict means the model misidentified the object.
        # The bbox position may be usable but the class label is unreliable,
        # so send these to manual annotation instead of auto-mapping.
        if verdict == "wrong":
            needs_annotation.append(entry)
            continue

        # Build YOLO annotation lines (only for "correct" verdicts)
        label_lines = []
        for det in dets:
            coco_name = det["className"]
            bbox_norm = det["bboxNorm"]  # [x_center, y_center, w, h] already normalized

            # Map COCO class to waste class
            waste_class_id = map_coco_to_waste_class(coco_name)

            if waste_class_id is None:
                unmapped_coco[coco_name] += 1
                continue

            label_lines.append(
                f"{waste_class_id} {bbox_norm[0]:.6f} {bbox_norm[1]:.6f} {bbox_norm[2]:.6f} {bbox_norm[3]:.6f}"
            )
            class_counts[CLASS_NAMES[waste_class_id]] += 1

        if not label_lines:
            # All detections were unmapped → treat as needs_annotation
            needs_annotation.append(entry)
            continue

        annotated.append({
            "entry": entry,
            "labels": label_lines,
            "index": i,
        })

    # ── Split train/val ──
    random.seed(args.seed)
    random.shuffle(annotated)
    n_train = int(len(annotated) * args.split_ratio)
    splits = {
        "train": annotated[:n_train],
        "val": annotated[n_train:],
    }

    # ── Copy or download images and write labels ──
    for split_name, split_data in splits.items():
        print(f"\n  {split_name}: {len(split_data)} images")
        for item in split_data:
            entry = item["entry"]
            idx = item["index"]
            fname = f"pilot_{idx:04d}.jpg"

            img_path = out_dir / "images" / split_name / fname
            lbl_path = out_dir / "labels" / split_name / f"pilot_{idx:04d}.txt"

            # Use local image from ZIP if available, otherwise download
            if not img_path.exists():
                local = entry.get("_localImage")
                if local and Path(local).exists():
                    shutil.copy2(local, img_path)
                elif not args.skip_download and entry.get("imageUrl"):
                    ok = download_image(entry["imageUrl"], img_path)
                    if not ok:
                        continue

            # Write label file
            with open(lbl_path, "w") as f:
                f.write("\n".join(item["labels"]) + "\n")

    # ── Copy/download "needs annotation" images ──
    print(f"\n── Processing {len(needs_annotation)} images for manual annotation ──")
    roboflow_manifest = []
    for i, entry in enumerate(needs_annotation):
        fname = f"annotate_{i:04d}.jpg"
        img_path = out_dir / "needs_annotation" / fname

        if not img_path.exists():
            local = entry.get("_localImage")
            if local and Path(local).exists():
                shutil.copy2(local, img_path)
            elif not args.skip_download and entry.get("imageUrl"):
                download_image(entry["imageUrl"], img_path)

        correct_stream = entry.get("correctStream")
        likely_class = STREAM_TO_LIKELY_CLASS.get(correct_stream or "")

        roboflow_manifest.append({
            "file": fname,
            "itemName": entry.get("itemName", "unknown"),
            "correctStream": correct_stream,
            "likelyClass": CLASS_NAMES[likely_class] if likely_class is not None else "unknown",
            "confidence": entry.get("confidence", 0),
            "modelUsed": entry.get("modelUsed", "unknown"),
            "verdict": entry.get("verdict"),
        })

    # ── False detections: NOT used for model training ──
    # False detections are environment-specific (background, lighting, camera angle)
    # and don't generalize across facilities. They are handled by:
    #   1. FrameAnalyzer background subtraction (auto-adapts per facility)
    #   2. Detection confidence threshold (configurable per site config)
    # Instead, we output false detection statistics for threshold tuning.

    # ── Write data.yaml ──
    yaml_path = out_dir / "data.yaml"
    abs_path = out_dir.resolve()
    with open(yaml_path, "w") as f:
        f.write(f"# Pilot dataset for YOLO fine-tuning\n")
        f.write(f"# Generated from reviewed kiosk classifications\n")
        f.write(f"# Merge with TACO dataset for combined training\n\n")
        f.write(f"path: {abs_path}\n")
        f.write(f"train: images/train\n")
        f.write(f"val: images/val\n\n")
        f.write(f"nc: {len(CLASS_NAMES)}\n")
        f.write(f"names: {CLASS_NAMES}\n")

    # ── Write manifest ──
    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump({
            "generated_at": __import__("datetime").datetime.now().isoformat(),
            "total_entries": len(entries),
            "annotated": len(annotated),
            "needs_annotation": len(needs_annotation),
            "false_detections": len(false_detections),
            "skipped": len(skipped),
            "class_names": CLASS_NAMES,
            "coco_to_waste_class": {k: CLASS_NAMES[v] for k, v in COCO_TO_WASTE_CLASS.items()},
            "needs_annotation_manifest": roboflow_manifest,
        }, f, indent=2, ensure_ascii=False)

    # ── Write report ──
    report_path = out_dir / "report.txt"
    with open(report_path, "w") as f:
        f.write("PILOT DATA FINE-TUNING REPORT\n")
        f.write("=" * 50 + "\n\n")

        f.write(f"Total reviewed entries:    {len(entries)}\n")
        f.write(f"Auto-annotated (w/ bbox):  {len(annotated)}\n")
        f.write(f"  Train:                   {len(splits['train'])}\n")
        f.write(f"  Val:                     {len(splits['val'])}\n")
        f.write(f"Needs manual annotation:   {len(needs_annotation)}\n")
        f.write(f"False detections:          {len(false_detections)}\n")
        f.write(f"Skipped (no image):        {len(skipped)}\n\n")

        f.write("CLASS DISTRIBUTION (auto-annotated):\n")
        for name in CLASS_NAMES:
            count = class_counts.get(name, 0)
            bar = "█" * min(count, 50)
            f.write(f"  {name:20s}  {count:4d}  {bar}\n")

        if unmapped_coco:
            f.write(f"\nUNMAPPED COCO CLASSES (detections ignored):\n")
            for name, count in unmapped_coco.most_common():
                f.write(f"  {name:20s}  {count:4d}\n")
            f.write(f"\nTo include these, add mappings to COCO_TO_WASTE_CLASS in this script.\n")

        f.write(f"\nNEEDS ANNOTATION ({len(needs_annotation)} images):\n")
        f.write(f"Includes: images without YOLO detections + 'wrong' verdict entries\n")
        f.write(f"(wrong verdicts have bbox position but unreliable class labels).\n")
        f.write(f"Import the needs_annotation/ folder into Roboflow for manual bbox annotation.\n")
        f.write(f"See manifest.json for item names and likely classes.\n\n")

        f.write(f"FALSE DETECTIONS ({len(false_detections)} entries):\n")
        f.write(f"NOT used for model training (environment-specific, doesn't generalize).\n")
        f.write(f"Instead, tune per-facility:\n")
        f.write(f"  - confidence_threshold in yolo-rules.json\n")
        f.write(f"  - ROI_FG_THRESHOLD in frame-analyzer.ts\n")
        if false_detections:
            fd_confidences = [e.get("confidence", 0) for e in false_detections]
            avg_conf = sum(fd_confidences) / len(fd_confidences)
            f.write(f"  Avg confidence of false detections: {avg_conf:.2f}\n")

        f.write(f"\nNEXT STEPS:\n")
        f.write(f"1. Annotate needs_annotation/ images in Roboflow\n")
        f.write(f"2. Export Roboflow annotations in YOLO format\n")
        f.write(f"3. Merge with this dataset's images/ and labels/ directories\n")
        f.write(f"4. Merge with TACO dataset (training/dataset/) for combined training\n")
        f.write(f"5. Run fine-tuning:\n")
        f.write(f"   caffeinate python supplement_and_train.py\n")
        f.write(f"\nIMPORTANT: This produces a GLOBAL model, not facility-specific.\n")
        f.write(f"Merge data from ALL facilities into one training set.\n")
        f.write(f"Facility-specific rules are handled by site config JSON, not the model.\n")

    print(f"\n{'=' * 50}")
    print(f"Output: {out_dir.resolve()}")
    print(f"  data.yaml:          Dataset config")
    print(f"  images/train/:      {len(splits['train'])} training images")
    print(f"  images/val/:        {len(splits['val'])} validation images")
    print(f"  labels/train/:      YOLO annotation files")
    print(f"  labels/val/:        YOLO annotation files")
    print(f"  needs_annotation/:  {len(needs_annotation)} images for Roboflow")
    print(f"  manifest.json:      Full metadata")
    print(f"  report.txt:         Summary report")

    # Clean up temporary extraction directory
    if tmp_dir and Path(tmp_dir).exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)

    print(f"\nDone!")


if __name__ == "__main__":
    main()
