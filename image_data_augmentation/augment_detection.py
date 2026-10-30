import cv2
import albumentations as A
import os
import glob
from tqdm import tqdm
import math
from typing import List, Optional, Tuple

import numpy as np

_IMAGE_GLOBS = ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG")

# Drop detection boxes that lose this much of their original area after crop/rotate.
_MIN_BBOX_VISIBILITY = 0.3
# Masks (often tiny rust polygons) keep a bit more of a partial instance.
_MIN_MASK_VISIBILITY = 0.1
_MIN_MASK_PIXELS = 8


def list_image_files(img_dir: str) -> List[str]:
    """List image paths under img_dir; matches Node augmentationWorker.js pool (.jpg / .jpeg / .png)."""
    if not os.path.isdir(img_dir):
        return []
    paths: List[str] = []
    for pat in _IMAGE_GLOBS:
        paths.extend(glob.glob(os.path.join(img_dir, pat)))
    return sorted(set(paths))


# NOTE:
# This module was originally written as a standalone script with hard‑coded
# INPUT_ROOT_DIR / OUTPUT_ROOT_DIR / TARGET_TRAIN_TOTAL / VAL_TEST_MULTIPLIER.
# It has been refactored to expose reusable functions that take those values
# as parameters so it can be safely called from the backend without changing
# the augmentation behavior.
#
# Label formats (auto-detected per line):
#   Detection:     class_id cx cy w h
#   Segmentation:  class_id x1 y1 x2 y2 ... xn yn  (odd token count >= 7)


def _spatial_transforms(target_size: int, border_mode: int, fill: float, fill_mask: float):
    """Shared geometric + color transforms. Spatial ops also apply to masks."""
    return [
        # --- 1. Orientation ---
        A.Rotate(
            limit=30,
            p=0.6,
            border_mode=border_mode,
            fill=fill,
            fill_mask=fill_mask,
            mask_interpolation=cv2.INTER_NEAREST,
        ),
        A.HorizontalFlip(p=0.5),
        # --- 2. Zoom/Crop ---
        A.RandomResizedCrop(
            size=(target_size, target_size),
            scale=(0.85, 1.0),
            ratio=(0.9, 1.1),
            p=1.0,
        ),
        # --- 3. Lighting/Color (image only; masks stay binary) ---
        A.RandomBrightnessContrast(
            brightness_limit=0.1, contrast_limit=0.1, p=0.5
        ),
        A.GaussianBlur(blur_limit=(3, 3), p=0.1),
    ]


def get_bbox_pipeline(target_size: int = 640) -> A.Compose:
    """
    Detection pipeline (unchanged behavior).
    CRITICAL: Includes 'bbox_params' so boxes move with the image.
    """
    return A.Compose(
        _spatial_transforms(
            target_size,
            border_mode=cv2.BORDER_REFLECT_101,
            fill=0,
            fill_mask=0,
        ),
        bbox_params=A.BboxParams(
            format="yolo", min_visibility=_MIN_BBOX_VISIBILITY, label_fields=["class_labels"]
        ),
    )


def get_seg_pipeline(target_size: int = 640) -> A.Compose:
    """
    Segmentation pipeline.

    ❗ Use CONSTANT borders so reflected pixels do not copy rust masks into padded
       regions (REFLECT is fine for boxes, wrong for instance masks).
    Masks are passed as a list of HxW uint8 arrays; Albumentations warps them
    with the image (nearest-neighbor).
    """
    return A.Compose(
        _spatial_transforms(
            target_size,
            border_mode=cv2.BORDER_CONSTANT,
            fill=0,
            fill_mask=0,
        ),
        bbox_params=A.BboxParams(
            format="yolo", min_visibility=_MIN_BBOX_VISIBILITY, label_fields=["class_labels"]
        ),
    )


def clip_yolo_bbox(bbox: List[float]) -> Optional[List[float]]:
    """Clip a YOLO box to [0,1]. Returns None if the box has no remaining area."""
    cx, cy, bw, bh = bbox
    x1 = max(0.0, min(1.0, cx - bw / 2.0))
    y1 = max(0.0, min(1.0, cy - bh / 2.0))
    x2 = max(0.0, min(1.0, cx + bw / 2.0))
    y2 = max(0.0, min(1.0, cy + bh / 2.0))
    if x2 <= x1 or y2 <= y1:
        return None
    return [(x1 + x2) / 2.0, (y1 + y2) / 2.0, x2 - x1, y2 - y1]


def classify_yolo_line(parts: List[str]) -> Optional[str]:
    """Return 'detection', 'segmentation', or None if the line is invalid."""
    if len(parts) == 5:
        return "detection"
    # YOLO_SEG: class + even number of coords, at least 3 points → odd token count >= 7
    if len(parts) >= 7 and len(parts) % 2 == 1:
        return "segmentation"
    return None


def read_yolo_label(
    label_path: str,
) -> Tuple[List[List[float]], List[int], List[List[Tuple[float, float]]], List[int]]:
    """
    Read a YOLO .txt file.

    Returns:
      bboxes, bbox_class_ids, polygons, polygon_class_ids
      polygons are lists of (x, y) in normalized 0–1 coordinates.
    """
    bboxes: List[List[float]] = []
    bbox_class_ids: List[int] = []
    polygons: List[List[Tuple[float, float]]] = []
    polygon_class_ids: List[int] = []

    if not os.path.exists(label_path):
        return bboxes, bbox_class_ids, polygons, polygon_class_ids

    with open(label_path, "r") as f:
        for line in f:
            parts = line.strip().split()
            kind = classify_yolo_line(parts)
            if kind is None:
                continue
            try:
                class_id = int(float(parts[0]))
            except ValueError:
                continue

            if kind == "detection":
                # ✅ YOLO detect: x_center, y_center, width, height
                clipped = clip_yolo_bbox([float(x) for x in parts[1:5]])
                if clipped is None:
                    continue
                bboxes.append(clipped)
                bbox_class_ids.append(class_id)
            else:
                coords = [float(x) for x in parts[1:]]
                pts: List[Tuple[float, float]] = []
                for i in range(0, len(coords), 2):
                    x = min(1.0, max(0.0, coords[i]))
                    y = min(1.0, max(0.0, coords[i + 1]))
                    pts.append((x, y))
                if len(pts) >= 3:
                    polygons.append(pts)
                    polygon_class_ids.append(class_id)

    return bboxes, bbox_class_ids, polygons, polygon_class_ids


def polygons_to_masks(
    polygons: List[List[Tuple[float, float]]],
    height: int,
    width: int,
) -> Tuple[List[np.ndarray], List[int]]:
    """Rasterize normalized polygons to uint8 masks. Drops empty (zero-area) masks."""
    masks: List[np.ndarray] = []
    keep_indices: List[int] = []
    for idx, poly in enumerate(polygons):
        mask = np.zeros((height, width), dtype=np.uint8)
        pts = np.array(
            [[int(round(x * width)), int(round(y * height))] for x, y in poly],
            dtype=np.int32,
        )
        if len(pts) >= 3:
            cv2.fillPoly(mask, [pts], 1)
        if int(mask.sum()) >= _MIN_MASK_PIXELS:
            masks.append(mask)
            keep_indices.append(idx)
    return masks, keep_indices


def mask_to_polygon(
    mask: np.ndarray,
    orig_area: int,
    min_visibility: float = _MIN_MASK_VISIBILITY,
) -> Optional[List[Tuple[float, float]]]:
    """
    Convert a warped instance mask back to a YOLO_SEG polygon.
    Drops masks that lost too much area (crop/rotate) or have < 3 vertices.
    """
    binary = (mask > 0).astype(np.uint8)
    area = int(binary.sum())
    if area < _MIN_MASK_PIXELS:
        return None
    if orig_area > 0 and (area / float(orig_area)) < min_visibility:
        return None

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < _MIN_MASK_PIXELS:
        return None

    peri = cv2.arcLength(contour, True)
    epsilon = max(0.5, 0.002 * peri)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    if len(approx) < 3:
        approx = contour
    if len(approx) < 3:
        return None

    h, w = binary.shape[:2]
    if w <= 0 or h <= 0:
        return None
    pts: List[Tuple[float, float]] = []
    for px, py in approx.reshape(-1, 2):
        x = min(1.0, max(0.0, float(px) / float(w)))
        y = min(1.0, max(0.0, float(py) / float(h)))
        pts.append((x, y))
    if len(pts) < 3:
        return None
    return pts


def save_yolo_label(
    output_path: str,
    bboxes: List[List[float]],
    bbox_class_ids: List[int],
    polygons: Optional[List[List[Tuple[float, float]]]] = None,
    polygon_class_ids: Optional[List[int]] = None,
) -> None:
    """Write detection boxes and/or segmentation polygons to a YOLO .txt file."""
    polygons = polygons or []
    polygon_class_ids = polygon_class_ids or []
    with open(output_path, "w") as f:
        for bbox, cls_id in zip(bboxes, bbox_class_ids):
            x_c, y_c, bw, bh = [max(0.0, min(1.0, val)) for val in bbox]
            f.write(f"{cls_id} {x_c:.6f} {y_c:.6f} {bw:.6f} {bh:.6f}\n")
        for poly, cls_id in zip(polygons, polygon_class_ids):
            coords = " ".join(f"{x:.6f} {y:.6f}" for x, y in poly)
            f.write(f"{cls_id} {coords}\n")


def process_subset(
    input_root_dir: str,
    output_root_dir: str,
    subset_name: str,
    multiplier: int = None,
    target_total: int = None,
    target_size: int = 640,
) -> None:
    """
    Processes a specific folder (train, val, or test).
    Auto-detects YOLO detect vs YOLO_SEG labels per image.
    """
    input_img_dir = os.path.join(input_root_dir, "images", subset_name)
    input_lbl_dir = os.path.join(input_root_dir, "labels", subset_name)

    output_img_dir = os.path.join(output_root_dir, "images", subset_name)
    output_lbl_dir = os.path.join(output_root_dir, "labels", subset_name)

    os.makedirs(output_img_dir, exist_ok=True)
    os.makedirs(output_lbl_dir, exist_ok=True)

    image_files = list_image_files(input_img_dir)

    if not image_files:
        print(f"No images found in {subset_name}. Skipping.")
        return

    num_original = len(image_files)

    if target_total:
        if num_original >= target_total:
            count_per_image = 1
            print(f"[{subset_name}] Already has {num_original} images. No extra copies needed.")
        else:
            count_per_image = math.ceil(target_total / num_original)
            print(f"[{subset_name}] Augmenting {num_original} images -> Target {target_total} (x{count_per_image} per image)")
    else:
        count_per_image = multiplier
        print(f"[{subset_name}] Augmenting {num_original} images by factor x{count_per_image}")

    detect_pipeline = get_bbox_pipeline(target_size=target_size)
    seg_pipeline = get_seg_pipeline(target_size=target_size)

    seg_files = 0
    detect_files = 0

    for img_path in tqdm(image_files, desc=f"Processing {subset_name}"):
        image = cv2.imread(img_path)
        if image is None:
            continue
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        img_h, img_w = image.shape[:2]

        base_name = os.path.splitext(os.path.basename(img_path))[0]
        label_path = os.path.join(input_lbl_dir, base_name + ".txt")
        bboxes, bbox_class_ids, polygons, polygon_class_ids = read_yolo_label(label_path)

        masks: List[np.ndarray] = []
        mask_class_ids: List[int] = []
        orig_mask_areas: List[int] = []
        if polygons:
            raw_masks, keep_idx = polygons_to_masks(polygons, img_h, img_w)
            masks = raw_masks
            mask_class_ids = [polygon_class_ids[i] for i in keep_idx]
            orig_mask_areas = [int(m.sum()) for m in masks]

        if polygons and not masks:
            print(f"Skipping {base_name}: segmentation polygons rasterized to empty masks")
            continue

        if masks:
            seg_files += 1
            pipeline = seg_pipeline
        else:
            detect_files += 1
            pipeline = detect_pipeline

        had_labels = (len(bboxes) > 0) or (len(masks) > 0)

        # A copy whose crop cut out every defect is thrown away, so try again with a new
        # random crop (a few attempts per copy) instead of ending up short of the target
        made = 0
        attempts = 0
        max_attempts = count_per_image * 5
        while made < count_per_image and attempts < max_attempts:
            attempts += 1
            i = made
            try:
                kwargs = {
                    "image": image,
                    "bboxes": bboxes,
                    "class_labels": bbox_class_ids,
                }
                if masks:
                    kwargs["masks"] = masks

                transformed = pipeline(**kwargs)

                aug_image = transformed["image"]
                aug_bboxes = list(transformed["bboxes"])
                aug_bbox_ids = list(transformed["class_labels"])

                aug_polygons: List[List[Tuple[float, float]]] = []
                aug_poly_ids: List[int] = []
                if masks:
                    aug_masks = transformed.get("masks") or []
                    for mask, cls_id, orig_area in zip(aug_masks, mask_class_ids, orig_mask_areas):
                        poly = mask_to_polygon(mask, orig_area=orig_area)
                        if poly is None:
                            continue
                        aug_polygons.append(poly)
                        aug_poly_ids.append(cls_id)

                # If every instance was cropped out, skip (same as old bbox behavior)
                if had_labels and len(aug_bboxes) == 0 and len(aug_polygons) == 0:
                    continue

                src_ext = os.path.splitext(img_path)[1].lower()
                if src_ext not in (".jpg", ".jpeg", ".png"):
                    src_ext = ".jpg"
                save_name = f"{base_name}_aug_{i}{src_ext}"
                cv2.imwrite(
                    os.path.join(output_img_dir, save_name),
                    cv2.cvtColor(aug_image, cv2.COLOR_RGB2BGR),
                )

                save_yolo_label(
                    os.path.join(output_lbl_dir, f"{base_name}_aug_{i}.txt"),
                    aug_bboxes,
                    aug_bbox_ids,
                    aug_polygons,
                    aug_poly_ids,
                )
                made += 1

            except Exception as e:
                print(f"Error processing {base_name}: {e}")

        if made < count_per_image:
            print(f"[{subset_name}] {base_name}: made {made} of {count_per_image} copies (defect kept getting cropped out)")

    print(
        f"[{subset_name}] Label mix: {seg_files} segmentation image(s), "
        f"{detect_files} detection/empty image(s)"
    )


def run_augmentation(
    input_root_dir: str,
    output_root_dir: str,
    target_train_total: int = 1000,
    val_test_multiplier: int = 2,
    target_size: int = 640,
) -> None:
    """
    High‑level helper that runs augmentation for train/val/test subsets.

    This keeps the original behavior (train uses target_total, val/test use
    multiplier) but makes paths and parameters configurable for backend use.
    """
    if not os.path.exists(input_root_dir):
        raise FileNotFoundError(
            f"Input root directory does not exist: {input_root_dir}"
        )

    process_subset(
        input_root_dir=input_root_dir,
        output_root_dir=output_root_dir,
        subset_name="train",
        target_total=target_train_total,
        target_size=target_size,
    )

    process_subset(
        input_root_dir=input_root_dir,
        output_root_dir=output_root_dir,
        subset_name="val",
        multiplier=val_test_multiplier,
        target_size=target_size,
    )
    process_subset(
        input_root_dir=input_root_dir,
        output_root_dir=output_root_dir,
        subset_name="test",
        multiplier=val_test_multiplier,
        target_size=target_size,
    )
