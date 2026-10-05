#!/usr/bin/env bash
# Install or update the dinghysail.ing services on the uCore box, rootless, as the login user
# (`core`, next to the Minecraft server). Run on the box from this directory, without sudo:
#
#   ./install.sh                # first time: asks for the Cloudflare tunnel token
#   ./install.sh                # later: re-copies the units and restarts them
#   ./install.sh --new-token    # replace the stored tunnel token
#
# Idempotent. Quadlets: ~/.config/containers/systemd/; timer drop-in: ~/.config/systemd/user/.
# The services start at boot only if the user lingers (`loginctl enable-linger`); checked below.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID -ne 0 ]] || { echo "run as the normal user, not root/sudo" >&2; exit 1; }

if [[ "$(loginctl show-user "$USER" -p Linger --value)" != yes ]]; then
  echo "user $USER does not linger: services would stop at logout and not start at boot." >&2
  echo "run once: sudo loginctl enable-linger $USER" >&2
  exit 1
fi

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

quadlets="$HOME/.config/containers/systemd"
dropins="$HOME/.config/systemd/user/podman-auto-update.timer.d"
install -d -m 0755 "$quadlets" "$dropins"
install -m 0644 "$here/sail.network" "$here/sail.container" "$here/cloudflared.container" "$quadlets/"
install -m 0644 "$here/podman-auto-update.timer.d/10-every-5-minutes.conf" "$dropins/"

# Quadlet generates sail.service, cloudflared.service and sail-network.service on reload; their
# [Install] sections start them at boot, so they are started here rather than enabled.
systemctl --user daemon-reload
podman pull ghcr.io/lofilobzik/sail:latest docker.io/cloudflare/cloudflared:latest
systemctl --user restart sail.service cloudflared.service
systemctl --user enable --now podman-auto-update.timer

systemctl --user --no-pager --lines=0 status sail.service cloudflared.service
echo
echo "local check: $(curl -fsS http://127.0.0.1:8080/healthz || echo 'healthz FAILED')"
echo "next auto-update: $(systemctl --user show podman-auto-update.timer -p NextElapseUSecRealtime --value)"
