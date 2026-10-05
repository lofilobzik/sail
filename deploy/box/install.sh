#!/usr/bin/env bash
# Install or update the dinghysail.ing services on the uCore box. Run on the box from this directory:
#
#   sudo ./install.sh                # first time: asks for the Cloudflare tunnel token
#   sudo ./install.sh                # later: re-copies the units and restarts them
#   sudo ./install.sh --new-token    # replace the stored tunnel token
#
# Idempotent. Rootful quadlets: /etc/containers/systemd/; timer drop-in: /etc/systemd/system/.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

new_token=false
[[ "${1:-}" == "--new-token" ]] && new_token=true

if $new_token && podman secret exists cloudflared-token; then
  podman secret rm cloudflared-token >/dev/null
fi
if ! podman secret exists cloudflared-token; then
  # Read from the terminal, not argv, so the token never lands in shell history or `ps`.
  read -rsp "Cloudflare tunnel token (Zero Trust > Networks > Tunnels > your tunnel): " token
  echo
  [[ -n "$token" ]] || { echo "empty token" >&2; exit 1; }
  printf '%s' "$token" | podman secret create cloudflared-token - >/dev/null
  unset token
  echo "stored podman secret cloudflared-token"
fi

install -d -m 0755 /etc/containers/systemd /etc/systemd/system/podman-auto-update.timer.d
install -m 0644 "$here/sail.network" "$here/sail.container" "$here/cloudflared.container" /etc/containers/systemd/
install -m 0644 "$here/podman-auto-update.timer.d/10-every-5-minutes.conf" /etc/systemd/system/podman-auto-update.timer.d/

# Quadlet generates sail.service, cloudflared.service and sail-network.service on reload; their
# [Install] sections start them at boot, so they are started here rather than enabled.
systemctl daemon-reload
podman pull ghcr.io/lofilobzik/sail:latest docker.io/cloudflare/cloudflared:latest
systemctl restart sail.service cloudflared.service
systemctl enable --now podman-auto-update.timer

systemctl --no-pager --lines=0 status sail.service cloudflared.service
echo
echo "local check: $(curl -fsS http://127.0.0.1:8080/healthz || echo 'healthz FAILED')"
echo "next auto-update: $(systemctl show podman-auto-update.timer -p NextElapseUSecRealtime --value)"
