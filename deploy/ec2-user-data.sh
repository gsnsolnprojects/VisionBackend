#!/bin/bash
# First-boot setup for the VisionBackend API server (Amazon Linux 2023, x86_64).
# Installs Docker + Compose, writes the run files to /srv/vision and starts the app
# through a systemd service, which also starts it again after every reboot.
#
# __API_IMAGE__ is replaced with the ECR image (URL:tag) before launch.
set -euxo pipefail

dnf install -y docker
systemctl enable --now docker

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

mkdir -p /srv/vision/data /srv/vision/redis
echo "API_IMAGE=__API_IMAGE__" > /srv/vision/.env

cat > /srv/vision/docker-compose.yml <<'COMPOSE'
__COMPOSE__
COMPOSE

cat > /srv/vision/load-secrets.sh <<'SECRETS'
__LOAD_SECRETS__
SECRETS
chmod +x /srv/vision/load-secrets.sh

cat > /srv/vision/start.sh <<'START'
#!/bin/bash
# Log in to ECR, load settings from Parameter Store, pull the image (retrying while it's
# still being uploaded) and start the containers.
set -euo pipefail
cd /srv/vision
REGISTRY=191926569224.dkr.ecr.ap-south-1.amazonaws.com
/srv/vision/load-secrets.sh
for attempt in $(seq 1 60); do
  if aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin "$REGISTRY" \
     && docker compose pull; then
    break
  fi
  echo "Image not available yet (attempt $attempt); retrying in 60s"
  sleep 60
done
docker compose up -d
START
chmod +x /srv/vision/start.sh

cat > /etc/systemd/system/vision.service <<'UNIT'
[Unit]
Description=VisionBackend API (docker compose)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/srv/vision/start.sh
ExecStop=/usr/bin/docker compose --project-directory /srv/vision down
TimeoutStartSec=4200

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now vision.service
