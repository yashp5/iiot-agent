#!/usr/bin/env bash
# Deploy the analysis worker to a host running Docker, over SSH.
#
#   HOST=visa-ec2 scripts/deploy-worker.sh
#
# Source is copied rather than pulled from GitHub, so the host needs no repository
# credentials. Secrets are written once to a 0600 env file on the host and are never
# baked into the image or passed on a command line.
set -euo pipefail

HOST="${HOST:-visa-ec2}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/iiot-agent}"
CONTAINER="${CONTAINER:-iiot-worker}"
IMAGE="${IMAGE:-iiot-worker:latest}"

# Only what the worker itself needs. The device key belongs to the boiler gateway and the
# operator key to the dashboard; neither has any business on this host.
WORKER_VARS=(ACCOUNT_ID PRIVATE_KEY ANTHROPIC_API_KEY TOPIC_TELEMETRY TOPIC_ANALYSIS TOPIC_REPORTS TOPIC_DECISIONS)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

[[ -f .env ]] || { echo "no .env in $here"; exit 1; }

echo "→ collecting worker environment"
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
for var in "${WORKER_VARS[@]}"; do
  value="$(grep -E "^${var}=" .env | head -1 | cut -d= -f2- || true)"
  [[ -n "$value" ]] || { echo "  missing $var in .env"; exit 1; }
  printf '%s=%s\n' "$var" "$value" >> "$env_file"
done
echo "  ${#WORKER_VARS[@]} variables (no device or operator key)"

echo "→ syncing source to $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude web \
  --exclude .env --exclude '.env.*' --exclude .next \
  ./ "$HOST:$REMOTE_DIR/"

echo "→ installing environment file (0600)"
ssh "$HOST" "install -m 600 /dev/null $REMOTE_DIR/.env.worker"
scp -q "$env_file" "$HOST:$REMOTE_DIR/.env.worker"
ssh "$HOST" "chmod 600 $REMOTE_DIR/.env.worker"

echo "→ building image on the host"
ssh "$HOST" "cd $REMOTE_DIR && docker build -q -t $IMAGE ."

echo "→ restarting container"
ssh "$HOST" "docker rm -f $CONTAINER >/dev/null 2>&1 || true"
# Memory capped so the worker can never starve the other services on this box.
ssh "$HOST" "docker run -d --name $CONTAINER --restart unless-stopped \
  --env-file $REMOTE_DIR/.env.worker --memory 512m --log-opt max-size=10m --log-opt max-file=3 \
  $IMAGE"

sleep 3
ssh "$HOST" "docker ps --filter name=$CONTAINER --format '  {{.Names}}  {{.Status}}  {{.Image}}'"
echo "→ logs: make worker-logs"
