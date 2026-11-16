#!/bin/bash
# Hourly check of how easy it is to get one g4dn.xlarge GPU in Mumbai and the big regions abroad,
# using AWS's spare-capacity score (1 = hard, 10 = easy). One line per check goes to
# gpu-tracking/capacity.jsonl for the superadmin GPU tab. Read-only: starts nothing, costs nothing.
# Installed on the main server as /usr/local/bin/vision-gpu-capacity.sh (timer: hourly).
set -u
LOG_DIR=/srv/vision/data/gpu-tracking
LOG=$LOG_DIR/capacity.jsonl
mkdir -p "$LOG_DIR"

# AWS returns at most 10 regions per call, so two groups (Mumbai in both)
GROUPS_=(
  "ap-south-1 us-east-1 us-east-2 us-west-2 ca-central-1 eu-west-1 eu-west-2 eu-west-3"
  "ap-south-1 eu-central-1 eu-north-1 ap-southeast-1 ap-northeast-1 ap-northeast-3 ap-northeast-2 ap-southeast-2 sa-east-1"
)

pairs=""
for g in "${GROUPS_[@]}"; do
  out=$(aws ec2 get-spot-placement-scores --region ap-south-1 --instance-types g4dn.xlarge \
    --target-capacity 1 --target-capacity-unit-type units --no-single-availability-zone \
    --region-names $g --query 'SpotPlacementScores[].[Region,Score]' --output text 2>&1) || {
    echo "check failed: $out"; exit 1; }
  while read -r region score; do
    [ -n "$region" ] || continue
    case ",$pairs," in *",\"$region\":"*) continue ;; esac # Mumbai is in both groups
    pairs="${pairs:+$pairs,}\"$region\":$score"
  done <<< "$out"
done

printf '{"at":"%s","scores":{%s}}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pairs" >> "$LOG"
echo "recorded: $pairs"
