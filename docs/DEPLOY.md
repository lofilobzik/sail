# Deploying dinghysail.ing

```
push to main ─► GitHub Actions: test ─► build image ─► ghcr.io/lofilobzik/sail:latest
                                                            ▲ polled every 5 min
chinese-box (uCore, behind NAT), rootless podman as `core`, next to the Minecraft server
  podman-auto-update.timer (user) ───────────────────────────┘ pull + restart (rollback if unhealthy)
  sail.service         Go server: site + /ws on :8080 (127.0.0.1 only on the host)
  cloudflared.service  outbound tunnel ─► Cloudflare edge ◄─ https://dinghysail.ing
```

Nothing listens on the router: the box dials out to Cloudflare, and Cloudflare forwards
`https://dinghysail.ing` (including the `/ws` WebSocket) to `http://sail:8080` on a private podman
network. Your home IP is never published in DNS. That is why there are no A/AAAA records pointing at
home: the apex is a proxied CNAME to the tunnel, which Cloudflare flattens.

Files: `Containerfile`, `.github/workflows/deploy.yml`, `deploy/box/` (quadlets, timer drop-in,
`install.sh`). The image serves the built site and the game server on one origin, so the page
reaches the server at `wss://dinghysail.ing/ws`. Opening **https://dinghysail.ing** joins the
server automatically; `https://dinghysail.ing/?offline` sails locally in the browser instead. If the
server can't be reached within 5 s, the page says so and sails offline.

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

From the repo on your Mac, on the home network (box: `core@10.0.0.246`, SSH key in the keychain):

```sh
scp -r deploy/box/. core@10.0.0.246:sail-deploy/
ssh -t core@10.0.0.246 'cd ~/sail-deploy && ./install.sh'
```

Everything runs **rootless as `core`**, like the Minecraft container; there is no sudo. The units
start at boot because `core` lingers (`loginctl show-user core -p Linger` → `yes`). `install.sh`
refuses to run if linger is off, and tells you the one sudo command that turns it on.

`install.sh` asks for the tunnel token. It stores the token as a podman secret of `core`, read
from the terminal and never from argv. It then copies the quadlets to
`~/.config/containers/systemd/`, copies the timer drop-in to
`~/.config/systemd/user/podman-auto-update.timer.d/`, pulls both images, starts `sail` and
`cloudflared`, and enables the user's `podman-auto-update.timer`. It finishes by printing the unit
status and a local `/healthz` check.

`Notify=healthy` in `sail.container` needs Podman 5.1 or newer. The box has 5.8.

### 5. Check

```sh
curl -sS https://dinghysail.ing/healthz      # ok
```

Then open https://dinghysail.ing, press F3 for the debug panel, and the Network section
should say `wss://dinghysail.ing/ws connected`.

## Day to day

- **Deploy**: push to `main`. It is live within about 5 minutes of the workflow finishing.
  To deploy right away: `ssh core@10.0.0.246 podman auto-update`.
- **Logs** (on the box): `journalctl --user -u sail -f`, `journalctl --user -u cloudflared -f`.
- **Status**: `systemctl --user status sail cloudflared`, `podman ps`.
- **What would update**: `podman auto-update --dry-run`.
- **Rollback**: auto-update already rolls back if the new container never turns healthy. To pin a
  known-good build, set `Image=ghcr.io/lofilobzik/sail:sha-<commit>` in `deploy/box/sail.container`
  and re-run `install.sh`. Switch back to `:latest` the same way.
- **Change box config**: edit `deploy/box/*`, then copy it over and re-run `install.sh` as in step 4.
  The script is idempotent.
- **Rotate the tunnel token**: `./install.sh --new-token`.
- cloudflared also auto-updates from Docker Hub through the same timer; its own updater is off.

## Versions

The Esc menu shows `Alpha v<version> · build <commit>`. The version is maintained by hand, and
there is no release tooling. The build is the short commit, embedded by `vite.config.ts` in
production builds: from `GIT_COMMIT` (the workflow passes `github.sha` as a build argument),
otherwise from the checkout's `git rev-parse HEAD`. The dev server, tests and builds without git
show `dev`. A local image build passes it explicitly:
`podman build --build-arg GIT_COMMIT=$(git rev-parse HEAD) -f Containerfile .`

To release, set `"version"` in `package.json` (and `npm install --package-lock-only` so the lock
file matches), note the release below, and push to `main`. Change the `Alpha` label in
`src/version.ts` when the game leaves alpha.

- **0.1.0** Alpha: Buoy Tour Update (persistent challenges, the Buoy tour, sailor codes)

## Not covered

- No uptime alerting. Cloudflare shows the tunnel's health in the dashboard, and visitors get
  error 1033 or 502 while the box is down.
- Rebooting is not tested yet. The units are wired to the user's `default.target`, and linger
  starts that at boot, so they should come back like the Minecraft container does.
