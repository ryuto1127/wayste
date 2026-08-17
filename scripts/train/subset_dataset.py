"""Subset + remap a YOLO dataset to the demo classes.

Reuses the previously-vetted 15-class dataset (clean-trash photos, names
identical to lib/yolo-inference.ts WASTE_CLASSES) for the few-class demo
model — no relabeling needed. Boxes of dropped classes are removed; images
left with no boxes are kept as background negatives at a sampled rate
(negatives suppress false positives on scenery).

Usage (locally or in Colab, no extra deps):

    python subset_dataset.py --src path/to/15class_dataset --dst dataset \
        --classes plastic_bottle,can,paper_cup,plastic_cup,battery

Then add COCO spoon data on top (fetch_open_data.py) and train with
train_demo_yolo.py — its CLASSES list must match --classes + metal_spoon.
"""

import argparse
import random
import re
import shutil
from pathlib import Path

NEGATIVE_KEEP_RATE = 0.10


def parse_names(data_yaml: Path) -> list[str]:
    """Tolerant data.yaml `names` parser (list-form or inline-form)."""
    text = data_yaml.read_text(encoding="utf-8")
    inline = re.search(r"names:\s*\[(.*?)\]", text, re.S)
    if inline:
        return [n.strip().strip("'\"") for n in inline.group(1).split(",") if n.strip()]
    names: list[str] = []
    in_names = False
    for line in text.splitlines():
        if re.match(r"^names\s*:", line):
            in_names = True
            continue
        if in_names:
            m = re.match(r"^\s*-\s*(.+)$", line) or re.match(r"^\s*\d+\s*:\s*(.+)$", line)
            if m:
                names.append(m.group(1).strip().strip("'\""))
            elif line.strip():
                break
    return names


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="source YOLO dataset dir (contains data.yaml)")
    ap.add_argument("--dst", required=True, help="output dir")
    ap.add_argument("--classes", required=True, help="comma-separated class names to keep, in output order")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)
    src = Path(args.src)
    dst = Path(args.dst)
    keep = [c.strip() for c in args.classes.split(",") if c.strip()]

    src_names = parse_names(src / "data.yaml")
    missing = [c for c in keep if c not in src_names]
    if missing:
        raise SystemExit(f"classes not in source dataset: {missing} (source has: {src_names})")
    id_map = {src_names.index(c): i for i, c in enumerate(keep)}
    print(f"source classes: {len(src_names)} → keeping {keep}")

    totals: dict[str, list[int]] = {}
    for split in ("train", "valid", "val", "test"):
        labels_dir = src / split / "labels"
        if not labels_dir.is_dir():
            continue
        out_img = dst / split / "images"
        out_lbl = dst / split / "labels"
        out_img.mkdir(parents=True, exist_ok=True)
        out_lbl.mkdir(parents=True, exist_ok=True)
        kept = dropped = negatives = 0
        for lbl in sorted(labels_dir.glob("*.txt")):
            lines_out = []
            for line in lbl.read_text().splitlines():
                parts = line.split()
                if not parts:
                    continue
                cid = int(parts[0])
                if cid in id_map:
                    lines_out.append(" ".join([str(id_map[cid]), *parts[1:]]))
            img = next(
                (p for ext in (".jpg", ".jpeg", ".png")
                 for p in [src / split / "images" / (lbl.stem + ext)] if p.exists()),
                None,
            )
            if img is None:
                continue
            if lines_out:
                (out_lbl / lbl.name).write_text("\n".join(lines_out) + "\n")
                shutil.copy2(img, out_img / img.name)
                kept += 1
            elif random.random() < NEGATIVE_KEEP_RATE:
                (out_lbl / lbl.name).write_text("")
                shutil.copy2(img, out_img / img.name)
                negatives += 1
            else:
                dropped += 1
        totals[split] = [kept, negatives, dropped]
        print(f"{split}: {kept} kept, {negatives} negatives, {dropped} dropped")

    val_dir = next((s for s in ("valid", "val") if (dst / s).is_dir()), "valid")
    (dst / "data.yaml").write_text(
        f"train: train/images\nval: {val_dir}/images\n"
        + ("test: test/images\n" if (dst / "test").is_dir() else "")
        + f"nc: {len(keep)}\nnames: {keep}\n",
        encoding="utf-8",
    )
    print(f"wrote {dst}/data.yaml")


if __name__ == "__main__":
    main()
