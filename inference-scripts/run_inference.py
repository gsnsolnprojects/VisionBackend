#!/usr/bin/env python3
"""
YOLO Inference Script

This script runs inference on images and videos using a trained YOLO model.
It reads a JSON config file and runs YOLO inference, outputting
annotated images/videos and metadata.

Usage:
    python run_inference.py --config /path/to/inference-config.json
"""

import argparse
import json
import os
import sys
import shutil
import hashlib
import re
from pathlib import Path

try:
    from ultralytics import YOLO
except ImportError:
    print("ERROR: ultralytics package not found. Install with: pip install ultralytics", file=sys.stderr)
    sys.exit(1)

# moviepy is only needed for video conversion — do not import it on image jobs
# (importing it at startup adds several seconds before YOLO even loads).

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None
    np = None

# High-contrast BGR colors so classes do not all look like rust.
# Index 0/1/2 = first three defect classes (e.g. s1 / s2 / s3).
CLASS_MASK_COLORS_BGR = [
    (0, 255, 255),    # yellow
    (255, 0, 255),    # magenta
    (0, 220, 0),      # lime
    (255, 90, 0),     # blue
    (0, 140, 255),    # orange
    (255, 255, 0),    # cyan
    (180, 0, 255),    # violet
    (0, 255, 160),    # mint
]


def class_mask_color_bgr(cls_idx):
    return CLASS_MASK_COLORS_BGR[int(cls_idx) % len(CLASS_MASK_COLORS_BGR)]


def save_mask_only_image(result, dest_path, alpha=0.45):
    """
    Overwrite YOLO's default plot: filled masks + outline + class label.
    No bounding boxes. Each class id gets a different color.
    """
    if cv2 is None or np is None:
        return False
    orig = getattr(result, "orig_img", None)
    if orig is None:
        return False
    img = orig.copy()
    boxes = getattr(result, "boxes", None)
    names = getattr(result, "names", None) or {}
    mask_xy = []
    if hasattr(result, "masks") and result.masks is not None and hasattr(result.masks, "xy"):
        mask_xy = result.masks.xy or []

    overlay = img.copy()
    drawn = []
    for idx, poly in enumerate(mask_xy):
        if poly is None or len(poly) < 3:
            continue
        cls_idx = 0
        conf_score = 0.0
        if boxes is not None and idx < len(boxes):
            cls_idx = int(boxes.cls[idx])
            conf_score = float(boxes.conf[idx])
        color = class_mask_color_bgr(cls_idx)
        pts = np.asarray(poly, dtype=np.int32).reshape((-1, 1, 2))
        cv2.fillPoly(overlay, [pts], color)
        drawn.append((pts, color, cls_idx, conf_score))

    if drawn:
        cv2.addWeighted(overlay, alpha, img, 1.0 - alpha, 0, img)
        for pts, color, cls_idx, conf_score in drawn:
            cv2.polylines(img, [pts], True, color, 2, cv2.LINE_AA)
            label = names.get(cls_idx, f"class_{cls_idx}")
            text = f"{label} {conf_score:.2f}"
            x = int(pts[:, 0, 0].min())
            y = int(pts[:, 0, 1].min())
            y_text = max(18, y - 6)
            cv2.putText(img, text, (x, y_text), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(img, text, (x, y_text), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

    dest_dir = os.path.dirname(dest_path)
    if dest_dir:
        os.makedirs(dest_dir, exist_ok=True)
    params = []
    if dest_path.lower().endswith(('.jpg', '.jpeg')):
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 85]
    return bool(cv2.imwrite(dest_path, img, params))


def save_box_image(result, dest_path):
    """Write YOLO's standard picture (boxes + class + confidence) for a detection model result."""
    if cv2 is None:
        return False
    try:
        img = result.plot()  # BGR array with boxes and labels drawn
    except Exception as e:
        print(f"⚠️ Could not draw boxes: {e}", file=sys.stderr)
        return False
    dest_dir = os.path.dirname(dest_path)
    if dest_dir:
        os.makedirs(dest_dir, exist_ok=True)
    params = []
    if dest_path.lower().endswith(('.jpg', '.jpeg')):
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 85]
    return bool(cv2.imwrite(dest_path, img, params))


def compute_corrosion_coverage(result, file_detections):
    """
    Union of instance masks as % of image pixels.
    Overlaps count once in the total. Per-class percents can overlap each other.
    """
    if cv2 is None or np is None:
        return None
    orig = getattr(result, "orig_img", None)
    if orig is None:
        return None
    h, w = orig.shape[:2]
    if h <= 0 or w <= 0:
        return None
    pixel_count = float(h * w)
    union = np.zeros((h, w), dtype=np.uint8)
    class_masks = {}
    class_counts = {}
    class_confs = {}
    class_ids = {}

    mask_xy = []
    if hasattr(result, "masks") and result.masks is not None and hasattr(result.masks, "xy"):
        mask_xy = result.masks.xy or []

    for idx, det in enumerate(file_detections):
        cls_name = det.get("class") or "unknown"
        if det.get("classId") is not None:
            class_ids[cls_name] = int(det.get("classId"))
        class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
        class_confs.setdefault(cls_name, []).append(float(det.get("confidence") or 0))
        poly = None
        if idx < len(mask_xy) and mask_xy[idx] is not None and len(mask_xy[idx]) >= 3:
            poly = mask_xy[idx]
        elif det.get("polygon") is not None and len(det["polygon"]) >= 3:
            poly = det["polygon"]
        if poly is None:
            continue
        pts = np.array(poly, dtype=np.int32)
        if pts.ndim != 2 or pts.shape[0] < 3:
            continue
        inst = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(inst, [pts], 1)
        union = np.maximum(union, inst)
        if cls_name not in class_masks:
            class_masks[cls_name] = np.zeros((h, w), dtype=np.uint8)
        class_masks[cls_name] = np.maximum(class_masks[cls_name], inst)

    by_class = []
    for cls_name, mask in class_masks.items():
        confs = class_confs.get(cls_name) or []
        by_class.append({
            "class": cls_name,
            "classId": class_ids.get(cls_name),
            "percent": round(float(mask.sum()) / pixel_count * 100.0, 4),
            "count": int(class_counts.get(cls_name, 0)),
            "avgConfidence": round(sum(confs) / len(confs), 4) if confs else 0.0,
        })
    # Include classes that had boxes but no usable polygon
    for cls_name, count in class_counts.items():
        if cls_name in class_masks:
            continue
        confs = class_confs.get(cls_name) or []
        by_class.append({
            "class": cls_name,
            "classId": class_ids.get(cls_name),
            "percent": 0.0,
            "count": int(count),
            "avgConfidence": round(sum(confs) / len(confs), 4) if confs else 0.0,
        })
    by_class.sort(key=lambda x: x["percent"], reverse=True)
    return {
        "corrosionPercentTotal": round(float(union.sum()) / pixel_count * 100.0, 4),
        "byClass": by_class,
        "imageWidth": int(w),
        "imageHeight": int(h),
        "instanceCount": len(file_detections),
    }


def load_config(config_path):
    """Load inference configuration from JSON file."""
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        return config
    except FileNotFoundError:
        print(f"ERROR: Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in config file: {e}", file=sys.stderr)
        sys.exit(1)

def prepare_source_with_short_names(source, output, video_extensions):
    """
    If filenames are too long for Windows path limits, copy inputs to a temp
    folder with short, stable names and return the new source path.
    """
    if not os.path.isdir(source):
        return source, {}

    image_extensions = ['.jpg', '.jpeg', '.png']
    all_files = os.listdir(source)
    candidates = [
        f for f in all_files
        if any(f.lower().endswith(ext) for ext in image_extensions + video_extensions)
    ]

    # Check for Windows path-length risk
    annotated_dir = os.path.join(output, 'annotated')
    needs_short_names = any(
        len(os.path.join(annotated_dir, f)) >= 240 for f in candidates
    )

    if not needs_short_names:
        return source, {}

    short_dir = os.path.join(output, '_short_source')
    os.makedirs(short_dir, exist_ok=True)

    short_to_original = {}
    for idx, filename in enumerate(candidates):
        ext = os.path.splitext(filename)[1]
        digest = hashlib.md5(filename.encode('utf-8')).hexdigest()[:8]
        short_name = f"img_{idx:05d}_{digest}{ext}"

        src_path = os.path.join(source, filename)
        dest_path = os.path.join(short_dir, short_name)
        shutil.copy2(src_path, dest_path)
        short_to_original[short_name] = filename

    print(f"⚠️ Long filenames detected. Copied {len(candidates)} files to short-name folder: {short_dir}")
    sys.stdout.flush()
    return short_dir, short_to_original

def _load_video_file_clip():
    try:
        from moviepy import VideoFileClip
        return VideoFileClip
    except ImportError:
        from moviepy.editor import VideoFileClip
        return VideoFileClip


def convert_avi_to_mp4(source_path, mp4_path):
    """
    Convert video file to MP4 format for browser compatibility.
    
    Args:
        source_path: Path to input video file (any format)
        mp4_path: Path to output MP4 file
    
    Returns:
        bool: True if conversion successful, False otherwise
    """
    try:
        source_name = os.path.basename(source_path)
        mp4_name = os.path.basename(mp4_path)
        print(f"🔄 Converting {source_name} to MP4 format ({mp4_name})...")
        sys.stdout.flush()
        
        # Check if source file exists
        if not os.path.exists(source_path):
            print(f"❌ Error: Source file not found: {source_path}", file=sys.stderr)
            sys.stdout.flush()
            return False
        
        VideoFileClip = _load_video_file_clip()
        clip = VideoFileClip(source_path)
        
        # Write as MP4 with H.264 codec (browser-compatible)
        clip.write_videofile(
            mp4_path,
            codec='libx264',  # H.264 codec (widely supported)
            audio_codec='aac',  # AAC audio codec
            preset='medium',  # Encoding speed vs quality balance
            bitrate='5000k',  # Video bitrate
            audio_bitrate='128k',  # Audio bitrate
            logger=None  # Suppress verbose output
        )
        
        # Close clip to free resources
        clip.close()
        
        # Verify MP4 file was created
        if os.path.exists(mp4_path):
            print(f"✅ Conversion completed successfully: {mp4_name}")
            sys.stdout.flush()
            return True
        else:
            print(f"❌ Error: MP4 file was not created: {mp4_path}", file=sys.stderr)
            sys.stdout.flush()
            return False
        
    except Exception as e:
        print(f"❌ Error: Failed to convert {source_path} to MP4: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.stdout.flush()
        return False


def class_key(name):
    return re.sub(r"[\s_-]+", " ", str(name or "").strip().lower())


def kept_class_ids(model, hidden_classes):
    """Class ids to predict when some labels are hidden (sent by the worker as hiddenClasses,
    e.g. "product" in the Playground), or None to keep every class."""
    names = getattr(model, "names", None) or {}
    hidden = {class_key(n) for n in (hidden_classes or [])}
    if not hidden or not names:
        return None
    keep = [i for i, n in names.items() if class_key(n) not in hidden]
    if len(keep) == len(names) or not keep:
        return None
    print(f"Skipping hidden classes: {sorted(n for n in names.values() if class_key(n) in hidden)}")
    return keep


def apply_dataset_class_names(model, class_names):
    """Models trained before their dataset had class names carry placeholders (class_0,
    class_1, ...). Use the training dataset's names instead, in the same order (sent by the
    worker as classNames). Models with real names are left alone."""
    names = getattr(model, "names", None) or {}
    if not class_names or len(class_names) != len(names):
        return
    if not all(re.fullmatch(r"class_\d+", str(n)) for n in names.values()):
        return
    model.model.names = {i: str(n) for i, n in enumerate(class_names)}
    print(f"Class names from the training dataset: {list(model.model.names.values())}")


def run_inference(config):
    """Run YOLO inference with given configuration."""
    try:
        # Extract config values
        model_path = config.get('model')
        source = config.get('source')  # Image/video file or folder
        output = config.get('output')  # Output directory
        conf = config.get('conf', 0.25)  # Confidence threshold
        
        # ✅ Detect if source contains videos
        video_extensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v']
        is_video_file = os.path.isfile(source) and any(source.lower().endswith(ext) for ext in video_extensions)
        
        # ✅ If source is a folder, check for videos
        has_videos = False
        if os.path.isdir(source):
            files = os.listdir(source)
            has_videos = any(any(f.lower().endswith(ext) for ext in video_extensions) for f in files)

        # Validate required fields
        if not model_path:
            print("ERROR: 'model' field (path to model checkpoint) is required in config", file=sys.stderr)
            sys.exit(1)

        if not source:
            print("ERROR: 'source' field (path to image or folder) is required in config", file=sys.stderr)
            sys.exit(1)

        if not output:
            print("ERROR: 'output' field (path to output directory) is required in config", file=sys.stderr)
            sys.exit(1)

        # Validate paths
        if not os.path.exists(model_path):
            print(f"ERROR: Model file not found: {model_path}", file=sys.stderr)
            sys.exit(1)

        if not os.path.exists(source):
            print(f"ERROR: Source path not found: {source}", file=sys.stderr)
            sys.exit(1)

        # ✅ Create output directory
        os.makedirs(output, exist_ok=True)

        # ✅ If Windows path length is a risk, use short filenames
        source_for_inference, short_name_map = prepare_source_with_short_names(source, output, video_extensions)

        print(f"Loading model from: {model_path}")
        sys.stdout.flush()

        # ✅ Load YOLO model
        model = YOLO(model_path)
        apply_dataset_class_names(model, config.get('classNames'))

        print(f"✅ Model loaded successfully")
        print(f"Running inference on: {source}")
        print(f"Output directory: {output}")
        print(f"Confidence threshold: {conf}")
        if getattr(model, "names", None):
            print("Mask colors (no bounding boxes):")
            for cls_idx in sorted(model.names.keys()):
                b, g, r = class_mask_color_bgr(cls_idx)
                print(f"  {model.names[cls_idx]} → RGB({r},{g},{b})")
        if is_video_file or has_videos:
            print(f"🎬 Video files detected - will process videos")
        print("-" * 80)
        sys.stdout.flush()

        # Image-only jobs: do not let YOLO write its own plots; we write each picture once
        # ourselves (mask-only overlay for segmentation, boxes for detection).
        image_only = (not is_video_file) and (not has_videos)
        # Segmentation models are drawn as masks without boxes; detection models keep their boxes
        is_segmentation = getattr(model, 'task', None) == 'segment'
        annotated_dir = os.path.join(output, 'annotated')
        os.makedirs(annotated_dir, exist_ok=True)

        # ✅ Run inference
        # YOLO's predict() method can handle images, videos, and folders
        # For videos: saves annotated videos to {output}/annotated/
        # boxes=False (segmentation only): do not draw rectangles over the masks (ultralytics 8.1+)
        predict_kwargs = dict(
            source=source_for_inference,
            save=not image_only,
            save_txt=False,
            conf=conf,
            project=output,
            name='annotated',
            exist_ok=True,
            verbose=False,
        )
        keep_ids = kept_class_ids(model, config.get('hiddenClasses'))
        if keep_ids is not None:
            predict_kwargs['classes'] = keep_ids
        box_kwargs = {'boxes': False} if is_segmentation else {}
        try:
            results = model.predict(**predict_kwargs, **box_kwargs)
        except TypeError:
            predict_kwargs.pop('verbose', None)
            try:
                results = model.predict(**predict_kwargs, **box_kwargs)
            except TypeError:
                results = model.predict(**predict_kwargs)

        print("-" * 80)
        print("✅ Inference completed successfully!")
        sys.stdout.flush()

        # ✅ Collect metadata from results
        total_files = len(results)
        total_detections = 0
        all_detections = []
        detections_by_class = {}
        video_files = []
        image_files = []

        for i, result in enumerate(results):
            # ✅ YOLO saves files to {output}/annotated/ with the same name as source
            # result.path might be source path, but saved file is in annotated_dir
            file_path = result.path
            source_file_name = os.path.basename(file_path)
            
            # ✅ The actual saved file name (YOLO preserves original name)
            saved_file_name = source_file_name
            
            # ✅ Detect if this is a video file
            is_video = any(saved_file_name.lower().endswith(ext) for ext in video_extensions)
            file_type = 'video' if is_video else 'image'

            # ✅ Update progress
            if is_video:
                print(f"Processing video {i + 1}/{total_files}: {saved_file_name}")
            else:
                print(f"Processing image {i + 1}/{total_files}: {saved_file_name}")
            sys.stdout.flush()

            # ✅ For videos, YOLO processes frame by frame
            # result.boxes contains detections from all frames combined
            # For images, result.boxes contains detections from that image
            boxes = result.boxes
            mask_polygons = []
            if hasattr(result, 'masks') and result.masks is not None and hasattr(result.masks, 'xy'):
                mask_polygons = result.masks.xy or []
            num_detections = len(boxes) if boxes is not None else 0

            total_detections += num_detections

            file_detections = []
            if boxes is not None:
                for idx, box in enumerate(boxes):
                    # Get class, confidence, and bounding box
                    cls = int(box.cls[0])
                    conf = float(box.conf[0])
                    xyxy = box.xyxy[0].tolist()  # [x1, y1, x2, y2]

                    # Get class name
                    class_name = result.names[cls] if hasattr(result, 'names') else f'class_{cls}'

                    detection = {
                        'class': class_name,
                        'classId': cls,
                        'confidence': conf,
                        'bbox': xyxy
                    }
                    if idx < len(mask_polygons):
                        polygon = mask_polygons[idx]
                        if polygon is not None and len(polygon) > 0:
                            detection['polygon'] = polygon.tolist()
                    file_detections.append(detection)

                    # ✅ Track detections by class
                    if class_name not in detections_by_class:
                        detections_by_class[class_name] = {
                            'count': 0,
                            'confidences': []
                        }
                    detections_by_class[class_name]['count'] += 1
                    detections_by_class[class_name]['confidences'].append(conf)

            # ✅ Handle video conversion: Convert all videos to MP4 for browser compatibility
            final_file_name = saved_file_name
            if is_video:
                # ✅ Convert any video format to MP4 (not just AVI)
                video_extensions_list = ['.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v']
                current_ext = os.path.splitext(saved_file_name)[1].lower()
                
                # Only convert if not already MP4
                if current_ext != '.mp4':
                    # ✅ YOLO saves to {output}/annotated/{saved_file_name}
                    source_video_path = os.path.join(annotated_dir, saved_file_name)
                    mp4_file_name = os.path.splitext(saved_file_name)[0] + '.mp4'
                    mp4_path = os.path.join(annotated_dir, mp4_file_name)
                    
                    print(f"🔍 Checking for video file at: {source_video_path}")
                    sys.stdout.flush()
                    
                    if os.path.exists(source_video_path):
                        print(f"🔄 Converting {saved_file_name} to MP4 format...")
                        sys.stdout.flush()
                        
                        # Convert to MP4
                        if convert_avi_to_mp4(source_video_path, mp4_path):
                            # Update file name to MP4
                            final_file_name = mp4_file_name
                            
                            # Delete original video file
                            try:
                                os.remove(source_video_path)
                                print(f"🗑️ Deleted original video file: {saved_file_name}")
                                sys.stdout.flush()
                            except Exception as e:
                                print(f"⚠️ Warning: Could not delete original video file {source_video_path}: {e}", file=sys.stderr)
                                sys.stdout.flush()
                        else:
                            # Conversion failed, keep original video
                            print(f"⚠️ Warning: Conversion failed, keeping original video file: {saved_file_name}")
                            sys.stdout.flush()
                    else:
                        # ✅ Try alternative: check if YOLO saved with different name
                        print(f"⚠️ Warning: Source video file not found at: {source_video_path}")
                        print(f"🔍 Listing files in annotated directory: {annotated_dir}")
                        sys.stdout.flush()
                        if os.path.exists(annotated_dir):
                            try:
                                files_in_dir = os.listdir(annotated_dir)
                                print(f"📁 Files in annotated dir: {files_in_dir}")
                                sys.stdout.flush()
                                # Try to find any video file
                                video_files_in_dir = [f for f in files_in_dir if any(f.lower().endswith(ext) for ext in video_extensions_list + ['.mp4'])]
                                if video_files_in_dir:
                                    print(f"🎬 Found video files: {video_files_in_dir}")
                                    sys.stdout.flush()
                                    # Use the first video file found
                                    found_video = video_files_in_dir[0]
                                    if not found_video.lower().endswith('.mp4'):
                                        source_video_path = os.path.join(annotated_dir, found_video)
                                        mp4_file_name = os.path.splitext(found_video)[0] + '.mp4'
                                        mp4_path = os.path.join(annotated_dir, mp4_file_name)
                                        print(f"🔄 Attempting conversion of found file: {found_video}")
                                        sys.stdout.flush()
                                        if convert_avi_to_mp4(source_video_path, mp4_path):
                                            final_file_name = mp4_file_name
                                            try:
                                                os.remove(source_video_path)
                                                print(f"🗑️ Deleted original: {found_video}")
                                                sys.stdout.flush()
                                            except:
                                                pass
                            except Exception as e:
                                print(f"⚠️ Error listing directory: {e}", file=sys.stderr)
                                sys.stdout.flush()
                else:
                    # Already MP4, no conversion needed
                    print(f"✅ Video is already in MP4 format: {saved_file_name}")
                    sys.stdout.flush()

            # ✅ YOLO saves annotated files to {output}/annotated/{file_name}
            # Use final_file_name (MP4 if converted, original otherwise)
            # ✅ Ensure annotatedPath uses forward slashes (consistent across platforms)
            annotated_path = os.path.join('annotated', final_file_name).replace('\\', '/')
            file_info = {
                'filePath': final_file_name,
                'fileType': file_type,
                'annotatedPath': annotated_path,  # ✅ Use forward slashes for consistency
                'detections': file_detections,
                'detectionCount': num_detections
            }
            # Long names are shortened for the run; keep the name the photo had in its folder
            if short_name_map.get(source_file_name):
                file_info['originalName'] = short_name_map[source_file_name]
            if file_type == 'image':
                coverage = compute_corrosion_coverage(result, file_detections)
                if coverage:
                    file_info['corrosionPercentTotal'] = coverage['corrosionPercentTotal']
                    file_info['byClass'] = coverage['byClass']
                    file_info['imageWidth'] = coverage['imageWidth']
                    file_info['imageHeight'] = coverage['imageHeight']
                    file_info['instanceCount'] = coverage['instanceCount']
                # We write every result picture: segmentation -> mask-only overlay (no boxes),
                # detection -> YOLO's standard picture with boxes and labels
                annotated_image_path = os.path.join(annotated_dir, saved_file_name)
                if is_segmentation:
                    saved_ok = save_mask_only_image(result, annotated_image_path)
                    style = "Mask-only overlay"
                else:
                    saved_ok = save_box_image(result, annotated_image_path)
                    style = "Box overlay"
                if saved_ok:
                    print(f"🎨 {style} saved: {saved_file_name}")
                else:
                    print(f"⚠️ Could not save {style.lower()} for {saved_file_name}", file=sys.stderr)
                sys.stdout.flush()
            
            all_detections.append(file_info)
            
            if is_video:
                video_files.append(file_info)
            else:
                image_files.append(file_info)

        # ✅ POST-PROCESSING: Scan annotated directory and convert any non-MP4 videos
        # This handles the case where YOLO saves videos as .avi on Windows regardless of source filename
        if image_only:
            print("⏭️ Image-only job: skipping video conversion scan")
            sys.stdout.flush()
        else:
            print("-" * 80)
            print("🔍 Post-processing: Checking for videos that need conversion...")
            sys.stdout.flush()

        if (not image_only) and os.path.exists(annotated_dir):
            try:
                actual_files = os.listdir(annotated_dir)
                video_extensions_to_convert = ['.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v']
                
                # ✅ Find all video files that are NOT MP4
                videos_to_convert = [
                    f for f in actual_files 
                    if any(f.lower().endswith(ext) for ext in video_extensions_to_convert)
                ]
                
                if videos_to_convert:
                    print(f"📹 Found {len(videos_to_convert)} video(s) that need conversion to MP4")
                    sys.stdout.flush()
                    
                    # ✅ Create a mapping of original filename (without extension) to list of file info objects
                    # This handles cases where multiple videos have the same base name
                    filename_to_info_list = {}
                    for file_info in all_detections:
                        if file_info['fileType'] == 'video':
                            base_name = os.path.splitext(file_info['filePath'])[0]
                            if base_name not in filename_to_info_list:
                                filename_to_info_list[base_name] = []
                            filename_to_info_list[base_name].append(file_info)
                    
                    # ✅ Convert each video
                    for video_file in videos_to_convert:
                        source_video_path = os.path.join(annotated_dir, video_file)
                        base_name = os.path.splitext(video_file)[0]
                        mp4_file_name = base_name + '.mp4'
                        mp4_path = os.path.join(annotated_dir, mp4_file_name)
                        
                        print(f"🔄 Converting {video_file} to {mp4_file_name}...")
                        sys.stdout.flush()
                        
                        if convert_avi_to_mp4(source_video_path, mp4_path):
                            # ✅ Update metadata for all videos with this base name
                            if base_name in filename_to_info_list:
                                for file_info in filename_to_info_list[base_name]:
                                    file_info['filePath'] = mp4_file_name
                                    file_info['annotatedPath'] = os.path.join('annotated', mp4_file_name).replace('\\', '/')
                            
                            # ✅ Delete original video file
                            try:
                                os.remove(source_video_path)
                                print(f"🗑️ Deleted original video file: {video_file}")
                                sys.stdout.flush()
                            except Exception as e:
                                print(f"⚠️ Warning: Could not delete original video file {source_video_path}: {e}", file=sys.stderr)
                                sys.stdout.flush()
                        else:
                            print(f"⚠️ Warning: Failed to convert {video_file}, keeping original", file=sys.stderr)
                            sys.stdout.flush()
                else:
                    print("✅ All videos are already in MP4 format")
                    sys.stdout.flush()
            except Exception as e:
                print(f"⚠️ Warning: Error during video post-processing: {e}", file=sys.stderr)
                sys.stdout.flush()

        # ✅ POST-PROCESSING: Match actual saved image filenames with metadata
        # YOLO may normalize extensions (e.g., .jpeg -> .jpg) when saving
        print("-" * 80)
        print("🔍 Post-processing: Matching actual saved image filenames...")
        sys.stdout.flush()
        
        if os.path.exists(annotated_dir):
            try:
                actual_files = os.listdir(annotated_dir)
                image_extensions = ['.jpg', '.jpeg', '.png']
                
                # ✅ Find all image files in annotated directory
                actual_image_files = [
                    f for f in actual_files 
                    if any(f.lower().endswith(ext) for ext in image_extensions)
                ]
                
                if actual_image_files:
                    print(f"📸 Found {len(actual_image_files)} image file(s) in annotated directory")
                    sys.stdout.flush()
                    
                    # ✅ Create a mapping of base name (without extension) to actual filename
                    # This handles cases where YOLO changes extensions (e.g., .jpeg -> .jpg)
                    base_name_to_actual_file = {}
                    for actual_file in actual_image_files:
                        base_name = os.path.splitext(actual_file)[0]
                        # Handle multiple files with same base name (take the first one found)
                        if base_name not in base_name_to_actual_file:
                            base_name_to_actual_file[base_name] = actual_file
                    
                    # ✅ Update metadata for images that don't match actual filenames
                    updated_count = 0
                    for file_info in image_files:
                        if file_info['fileType'] == 'image':
                            expected_filename = file_info['filePath']
                            expected_base = os.path.splitext(expected_filename)[0]
                            
                            # Check if actual file exists with different extension
                            if expected_base in base_name_to_actual_file:
                                actual_filename = base_name_to_actual_file[expected_base]
                                
                                # If filename differs, update metadata
                                if actual_filename != expected_filename:
                                    print(f"🔄 Updating filename: {expected_filename} -> {actual_filename}")
                                    sys.stdout.flush()
                                    file_info['filePath'] = actual_filename
                                    file_info['annotatedPath'] = os.path.join('annotated', actual_filename).replace('\\', '/')
                                    updated_count += 1
                    
                    if updated_count > 0:
                        print(f"✅ Updated {updated_count} image filename(s) in metadata")
                        sys.stdout.flush()
                    else:
                        print("✅ All image filenames match actual saved files")
                        sys.stdout.flush()
                else:
                    print("⚠️ No image files found in annotated directory")
                    sys.stdout.flush()
            except Exception as e:
                print(f"⚠️ Warning: Error during image filename matching: {e}", file=sys.stderr)
                sys.stdout.flush()

        # ✅ Calculate average confidence
        all_confidences = []
        for det in all_detections:
            for d in det['detections']:
                all_confidences.append(d['confidence'])

        average_confidence = sum(all_confidences) / len(all_confidences) if all_confidences else 0.0

        # ✅ Calculate average confidence per class
        detections_by_class_list = []
        for class_name, stats in detections_by_class.items():
            avg_conf = sum(stats['confidences']) / len(stats['confidences']) if stats['confidences'] else 0.0
            detections_by_class_list.append({
                'className': class_name,
                'count': stats['count'],
                'avgConfidence': avg_conf
            })

        image_percents = [
            img.get('corrosionPercentTotal')
            for img in image_files
            if isinstance(img.get('corrosionPercentTotal'), (int, float))
        ]
        class_totals = {}
        for img in image_files:
            for row in img.get('byClass') or []:
                name = row.get('class')
                if not name:
                    continue
                bucket = class_totals.setdefault(name, {'percentSum': 0.0, 'count': 0, 'n': 0, 'classId': None})
                bucket['percentSum'] += float(row.get('percent') or 0)
                bucket['count'] += int(row.get('count') or 0)
                bucket['n'] += 1
                if bucket.get('classId') is None and row.get('classId') is not None:
                    bucket['classId'] = int(row.get('classId'))
        batch_by_class = [
            {
                'class': name,
                'classId': v.get('classId'),
                'meanPercent': round(v['percentSum'] / v['n'], 4) if v['n'] else 0.0,
                'count': v['count'],
            }
            for name, v in class_totals.items()
        ]
        batch_by_class.sort(key=lambda x: x['meanPercent'], reverse=True)
        names_map = getattr(model, 'names', None) or {}
        if isinstance(names_map, dict):
            class_names = [str(names_map[k]) for k in sorted(names_map.keys(), key=lambda x: int(x) if str(x).isdigit() else x)]
        else:
            class_names = [str(n) for n in list(names_map)]
        corrosion_stats = {
            'imageCount': len(image_files),
            'meanCorrosionPercent': round(sum(image_percents) / len(image_percents), 4) if image_percents else 0.0,
            'byClass': batch_by_class,
            'classNames': class_names,
        }

        # ✅ Generate metadata JSON
        metadata = {
            'totalFiles': total_files,
            'totalImages': len(image_files),
            'totalVideos': len(video_files),
            'totalDetections': total_detections,
            'averageConfidence': average_confidence,
            'detectionsByClass': detections_by_class_list,
            'classNames': class_names,
            'corrosionStats': corrosion_stats,
            'files': all_detections,  # All files (images + videos)
            'images': image_files,  # Image files only
            'videos': video_files  # Video files only
        }

        # ✅ Save metadata to JSON file
        metadata_path = os.path.join(output, 'metadata.json')
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)

        print(f"✅ Metadata saved to: {metadata_path}")
        print(f"📊 Total files processed: {total_files} ({len(image_files)} images, {len(video_files)} videos)")
        print(f"📊 Total detections: {total_detections}")
        print(f"📊 Average confidence: {average_confidence:.4f}")
        sys.stdout.flush()

        # ✅ Cleanup short-name source folder if used
        if short_name_map:
            try:
                shutil.rmtree(os.path.join(output, '_short_source'), ignore_errors=True)
            except Exception:
                pass

        return 0

    except KeyboardInterrupt:
        print("\nInference interrupted by user", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"ERROR: Inference failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Run YOLO inference')
    parser.add_argument('--config', required=True, help='Path to inference config JSON file')

    args = parser.parse_args()

    # Load configuration
    config = load_config(args.config)

    # Run inference
    exit_code = run_inference(config)

    sys.exit(exit_code)


if __name__ == '__main__':
    main()

