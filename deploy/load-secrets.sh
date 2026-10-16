#!/bin/sh
# Write /srv/vision/api.env from AWS Parameter Store (every parameter under /vision/api/).
# Runs on the EC2 server before the containers start; uses the server's IAM role.
#   /vision/api/MONGO_URI -> MONGO_URI=...
set -eu

REGION="${AWS_REGION:-ap-south-1}"
OUT=/srv/vision/api.env
TMP="$(mktemp)"

aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path /vision/api/ \
  --with-decryption \
  --recursive \
  --query 'Parameters[].[Name,Value]' \
  --output text |
while IFS="$(printf '\t')" read -r name value; do
  printf '%s=%s\n' "${name##*/}" "$value"
done > "$TMP"

if [ ! -s "$TMP" ]; then
  echo "No parameters found under /vision/api/ in $REGION" >&2
  rm -f "$TMP"
  exit 1
fi

install -m 600 "$TMP" "$OUT"
rm -f "$TMP"
echo "Wrote $(wc -l < "$OUT") settings to $OUT"
