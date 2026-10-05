# Deploying dinghysail.ing

```
push to main ─► GitHub Actions: test ─► build image ─► ghcr.io/lofilobzik/sail:latest
                                                            ▲ polled every 5 min
chinese-box (uCore, behind NAT)                              │
  podman-auto-update.timer ──────────────────────────────────┘ pull + restart (rollback if unhealthy)
  sail.service         Go server: site + /ws on :8080 (127.0.0.1 only on the host)
  cloudflared.service  outbound tunnel ─► Cloudflare edge ◄─ https://dinghysail.ing
```

Nothing listens on the router: the box dials out to Cloudflare, and Cloudflare forwards
`https://dinghysail.ing` (including the `/ws` WebSocket) to `http://sail:8080` on a private podman
network. Your home IP is never published in DNS. That is why there are no A/AAAA records pointing at
home: the apex is a proxied CNAME to the tunnel, which Cloudflare flattens.

Files: `Containerfile`, `.github/workflows/deploy.yml`, `deploy/box/` (quadlets, timer drop-in,
`install.sh`). The image serves the built site and the game server on one origin, so the page
reaches the server at `wss://dinghysail.ing/ws`. Open **https://dinghysail.ing/?server** to play
against the server; without `?server` the page sails offline in the browser, as in development.

## One-time setup

Do these in order: the box can only install once the image exists and is public.

### 1. Cloudflare takes over DNS (Porkbun stays the registrar)

1. In Porkbun, if **DNSSEC** is on for dinghysail.ing, turn it off (delete the DS record) and wait
   for it to clear. A stale DS record breaks resolution after the nameserver change.
2. In the Cloudflare dashboard, **Add a domain** → `dinghysail.ing` → **Free** plan.
3. Cloudflare imports the existing records. **Delete Porkbun's parking records** (typically an `ALIAS`/
   `CNAME` for the apex and `*` pointing at `pixie.porkbun.com`, plus any A/AAAA). The tunnel must
   be able to create the apex record itself.
4. Cloudflare shows two nameservers (`xxx.ns.cloudflare.com`). In Porkbun: **Domain Management** →
   dinghysail.ing → **Authoritative Nameservers** → replace the Porkbun ones with the two Cloudflare ones.
5. Wait until Cloudflare marks the domain **Active** (minutes to a few hours). Then you can re-enable
   DNSSEC from Cloudflare (DNS → Settings) and add the DS record it gives you in Porkbun.
6. Recommended: SSL/TLS → Edge Certificates → **Always Use HTTPS** on.

### 2. Create the tunnel (remotely managed)

1. Cloudflare **Zero Trust** → Networks → **Tunnels** → Create a tunnel → **Cloudflared** →
   name it `chinese-box`.
2. On the install page pick **Docker** and copy only the token: the long string after `--token`.
   The box runs cloudflared itself; you only need the token. Treat it like a password.
3. **Public hostname**: subdomain empty, domain `dinghysail.ing`, path empty, service
   **HTTP** → `sail:8080`. Save. This creates the proxied apex CNAME to `<tunnel-id>.cfargotunnel.com`.
   WebSockets need no extra setting.
4. Optional `www`: add a second public hostname, `www` → the same service, or add a redirect rule
   from `www.dinghysail.ing` to the apex.

### 3. Publish the first image

1. Push to `main`. The **test and publish** workflow runs the TS and Go tests, then pushes
   `ghcr.io/lofilobzik/sail:latest` and `:sha-<commit>` for amd64 and arm64.
2. GHCR creates new packages **private**, even for a public repo. Once only: GitHub → your profile →
   Packages → `sail` → Package settings → **Change visibility → Public**. Otherwise the box cannot pull
   without credentials.

### 4. Install on the box

From the repo on your Mac, on the home network:

```sh
scp -r deploy/box core@<box-ip>:~/sail-deploy
ssh -t core@<box-ip> 'cd ~/sail-deploy && sudo ./install.sh'
```

`install.sh` asks for the tunnel token. It stores the token as a podman secret, read from the
terminal and never from argv. It then copies the quadlets to `/etc/containers/systemd/`, copies
the timer drop-in, pulls both images, starts `sail` and `cloudflared`, and enables
`podman-auto-update.timer`. It finishes by printing the unit status and a local `/healthz` check.

`Notify=healthy` in `sail.container` needs Podman 5.1 or newer. Check with `podman --version`;
current uCore ships Podman 5. If it is older, delete that line.

### 5. Check

```sh
curl -sS https://dinghysail.ing/healthz      # ok
```

Then open https://dinghysail.ing/?server, press F3 for the debug panel, and the Network section
should say `wss://dinghysail.ing/ws connected`.

## Day to day

- **Deploy**: push to `main`. It is live within about 5 minutes of the workflow finishing.
  To deploy right away: `ssh core@<box-ip> sudo podman auto-update`.
- **Logs**: `journalctl -u sail -f`, `journalctl -u cloudflared -f`.
- **What would update**: `sudo podman auto-update --dry-run`.
- **Rollback**: auto-update already rolls back if the new container never turns healthy. To pin a
  known-good build, set `Image=ghcr.io/lofilobzik/sail:sha-<commit>` in `deploy/box/sail.container`
  and re-run `install.sh`. Switch back to `:latest` the same way.
- **Change box config**: edit `deploy/box/*`, then copy it over and re-run `install.sh` as in step 4.
  The script is idempotent.
- **Rotate the tunnel token**: `sudo ./install.sh --new-token`.
- cloudflared also auto-updates from Docker Hub through the same timer; its own updater is off.

## Not covered

- No uptime alerting. Cloudflare shows the tunnel's health in the dashboard, and visitors get
  error 1033 or 502 while the box is down.
- This is not tested on the real box: quadlet syntax, Podman features and the uCore layout are
  checked against the docs only. Report anything `install.sh` trips over.
