"""Audit + clean a YOLO dataset before training.

Catches the failure modes that silently inflate validation scores or
teach the model the wrong thing:

  - train/val LEAKAGE: the same image (byte-identical) in both splits.
    Validation mAP then measures memorization, not generalization.
  - exact duplicates within a split (re-exported/augmented copies).
  - label integrity: malformed lines, out-of-range coords, boxes that
    extend past the image edge, degenerate (near-zero) boxes.
  - class balance at BOTH image and box level (a class can look balanced
    by images yet dominate by boxes — e.g. many batteries per photo).

Usage:
    python audit_dataset.py --dir dataset            # report only
    python audit_dataset.py --dir dataset --fix      # also remove leakage/dupes
"""

import argparse
import collections
import hashlib
import os
from pathlib import Path

IMG_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def splits_in(root: Path) -> list[str]:
    return [s for s in ("train", "valid", "val", "test") if (root / s / "images").is_dir()]


def parse_names(data_yaml: Path) -> list[str]:
    import re
    text = data_yaml.read_text(encoding="utf-8")
    inline = re.search(r"names:\s*\[(.*?)\]", text, re.S)
    if inline:
        return [n.strip().strip("'\"") for n in inline.group(1).split(",") if n.strip()]
    return []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--fix", action="store_true", help="delete leaked val copies and duplicates")
    args = ap.parse_args()

    root = Path(args.dir)
    names = parse_names(root / "data.yaml") if (root / "data.yaml").exists() else []
    all_splits = splits_in(root)
    train_split = "train" if "train" in all_splits else all_splits[0]

    # ── Hash every image to find duplicates and leakage ──
    hashes: dict[str, list[tuple[str, Path]]] = collections.defaultdict(list)
    for split in all_splits:
        for img in sorted((root / split / "images").iterdir()):
            if img.suffix.lower() in IMG_EXTS:
                hashes[hashlib.md5(img.read_bytes()).hexdigest()].append((split, img))

    leaked = [v for v in hashes.values() if len({s for s, _ in v}) > 1]
    dupes = [v for v in hashes.values() if len(v) > 1 and len({s for s, _ in v}) == 1]

    # ── Label integrity + balance ──
    issues: collections.Counter[str] = collections.Counter()
    img_counts: dict[str, collections.Counter[int]] = {}
    box_counts: dict[str, collections.Counter[int]] = {}
    for split in all_splits:
        icount: collections.Counter[int] = collections.Counter()
        bcount: collections.Counter[int] = collections.Counter()
        for lbl in sorted((root / split / "labels").glob("*.txt")):
            present = set()
            for line in lbl.read_text().splitlines():
                parts = line.split()
                if not parts:
                    continue
                if len(parts) != 5:
                    issues[f"{split}: malformed line"] += 1
                    continue
                cid = int(parts[0])
                x, y, w, h = map(float, parts[1:])
                if names and not (0 <= cid < len(names)):
                    issues[f"{split}: class id out of range"] += 1
                if not all(0 <= v <= 1 for v in (x, y, w, h)):
                    issues[f"{split}: coord out of [0,1]"] += 1
                if x - w / 2 < -0.01 or y - h / 2 < -0.01 or x + w / 2 > 1.01 or y + h / 2 > 1.01:
                    issues[f"{split}: box past image edge"] += 1
                if w * h < 0.0002:
                    issues[f"{split}: degenerate box"] += 1
                bcount[cid] += 1
                present.add(cid)
            for cid in present:
                icount[cid] += 1
        img_counts[split] = icount
        box_counts[split] = bcount

    # ── Report ──
    print(f"dataset: {root}  splits: {all_splits}")
    print(f"\n--- balance ({train_split}) ---")
    ic, bc = img_counts[train_split], box_counts[train_split]
    for cid in sorted(set(ic) | set(bc)):
        label = names[cid] if cid < len(names) else str(cid)
        print(f"  {label:20s} images={ic[cid]:5d}  boxes={bc[cid]:5d}")
    if ic:
        ratio_i = max(ic.values()) / max(1, min(ic.values()))
        ratio_b = max(bc.values()) / max(1, min(bc.values()))
        print(f"  imbalance ratio — images {ratio_i:.2f}x, boxes {ratio_b:.2f}x"
              f"   ({'OK' if ratio_i <= 2 else 'consider topping up the smallest class'})")

    print(f"\n--- integrity ---")
    print(f"  {dict(issues) if issues else 'no label issues'}")
    print(f"  train/val leakage groups: {len(leaked)}")
    print(f"  duplicate groups within a split: {len(dupes)}")

    if not args.fix:
        if leaked or dupes:
            print("\nre-run with --fix to remove leaked val copies and duplicate images")
        return

    # ── Fix: keep the train copy of leaked pairs, keep one of each dupe ──
    removed = 0
    for group in leaked:
        for split, img in group:
            if split == train_split:
                continue
            lbl = root / split / "labels" / (img.stem + ".txt")
            img.unlink(missing_ok=True)
            lbl.unlink(missing_ok=True)
            removed += 1
    for group in dupes:
        for split, img in group[1:]:
            lbl = root / split / "labels" / (img.stem + ".txt")
            img.unlink(missing_ok=True)
            lbl.unlink(missing_ok=True)
            removed += 1
    print(f"\nremoved {removed} image/label pairs (leaked val copies + duplicates)")


if __name__ == "__main__":
    main()
