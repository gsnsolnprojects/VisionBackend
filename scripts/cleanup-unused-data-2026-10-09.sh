#!/usr/bin/env bash
# One-off clean-up of unused local data (checked against MongoDB on 2026-10-09).
# Nothing is deleted: everything is MOVED to a backup folder next to the project,
# keeping its original path, so it can be restored. Delete the backup folder
# yourself once you're sure nothing is missing; that is when disk space is freed.
#
# Run from Git Bash:  bash "/c/Gsn Soln/VisionBackend/scripts/cleanup-unused-data-2026-10-09.sh"
# Stop any running workers / uploads first.

set -u
cd "/c/Gsn Soln/VisionBackend" || exit 1
B="/c/Gsn Soln/VisionBackend_cleanup_backup_2026-10-09"
mkdir -p "$B"

mv_one() {
  local src="$1"
  if [ ! -e "$src" ]; then echo "skip (not found): $src"; return; fi
  mkdir -p "$B/$(dirname "$src")"
  mv "$src" "$B/$src" && echo "moved: $src"
}

# 1) Leftover temp files: move contents, keep the empty folders the app expects
for d in tmp training-temp inference-temp live-frames; do
  mkdir -p "$B/uploads/$d"
  n=$(ls -A "uploads/$d" | wc -l)
  find "uploads/$d" -mindepth 1 -maxdepth 1 -exec mv -t "$B/uploads/$d" {} + && echo "moved $n items from uploads/$d"
done

# 2) Model folders with no model record (failed / cancelled / crashed trainings)
for p in \
  "test/Terminal_RF_DETR_2" \
  "test/lightimages_aug_v2-2026-05-28" \
  "apple/v1" \
  "Corrosion/v1-2026-08-27" \
  "test/lightimages_aug_v3 test v8n" \
  "Car Seat/fabric_model_1" \
  "test/lightimages_aug_v2-2026-04-03" \
  "test/lightimages_aug_v3" \
  "test/v4" \
  "apple/v2" \
  "test/Terminal_RFDETR_2" \
  "Blister Pack/RF-DETR_new_blister_packet_v1-2026-05-25" \
  "Blister Pack/new_blister_packet_v1-2026-05-25" \
  "Blister Pack/RF-Detr_new_blister_packet_v1" \
  "test/test_rfdetr"; do
  mv_one "models/gsn/$p"
done

# 3) Stray dataset copy (real one lives in datasets/gsn/Corrosion) + empty result folder
mv_one "datasets/gsn/INS VARUNA/bike_rust_dup_aug"
mv_one "results/gsn/Vision/model_1769346930552_bw49h5t/inference_inf_1769352390259_470580b2"

echo
echo "Done. Backup: $B"
du -sh "$B"
