#!/usr/bin/env bash
# One-shot setup on a fresh Ubuntu/Debian VPS (run as root):
#   curl -fsSL https://raw.githubusercontent.com/duffpowell-commits/dufftkyosht/main/host/setup.sh | bash
# or from a checkout:  sudo bash host/setup.sh
set -euo pipefail

REPO=https://github.com/duffpowell-commits/dufftkyosht.git
DIR=/opt/rea-phone

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || (apt-get update && apt-get install -y git)

BRANCH="${REA_PHONE_BRANCH:-main}"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR/host"

if [ ! -f .env ]; then
  ip=$(curl -fsS https://api.ipify.org)
  # sslip.io maps 1-2-3-4.sslip.io -> 1.2.3.4, so Caddy can get a real HTTPS cert with no domain purchase.
  domain="${REA_DOMAIN:-${ip//./-}.sslip.io}"
  printf 'REA_DOMAIN=%s\nREA_TOKEN=%s\n' "$domain" "$(openssl rand -hex 32)" > .env
  chmod 600 .env
fi
set -a; . ./.env; set +a

docker compose up -d --build

echo
echo "Waiting for HTTPS + REA to come up..."
ok=""
for _ in $(seq 1 72); do
  if curl -fsS "https://$REA_DOMAIN/health" 2>/dev/null | grep -q '"rea":true'; then ok=1; break; fi
  sleep 5
done
if [ -z "$ok" ]; then
  echo "REA did not come up within 6 minutes. Check: docker compose -f $DIR/host/docker-compose.yml logs --tail 80" >&2
  echo "Common causes: ports 80/443 blocked by the provider firewall, or less than 4 GB RAM." >&2
  exit 1
fi
echo
echo "================================================================"
echo " Host URL : https://$REA_DOMAIN"
echo " Token    : $REA_TOKEN"
echo
echo " One-tap phone setup (open on your phone after the app is hosted):"
echo "   <APP_URL>/#host=https://$REA_DOMAIN&token=$REA_TOKEN"
echo "================================================================"
