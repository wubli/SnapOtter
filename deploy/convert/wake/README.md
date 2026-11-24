# Wake-on-visit for Convert

`convert.henesys.shop` is the Cloudflare Pages hostname. A separate record, `convert-origin.henesys.shop`, points to the reserved VM address `34.0.249.154`. Caddy authenticates the edge at the origin. The VM receives ordinary conversions and keeps the existing Compose volumes. Public uploads and downloads travel through Cloudflare. The free edge limits the entire HTTP request to 100 MB, including multipart overhead.

The [Pages worker](pages/README.md) remembers approved Google accounts in a signed browser cookie. [Cloud Run](controller/README.md) starts the VM when an authorized visitor needs it. The controller runs in `europe-central2` with zero minimum instances. Approve each account in the wake allowlist and in [SnapOtter](../GOOGLE_OIDC.md), then use the same Google account at both sign-ins. The local admin password remains available for recovery after passing the edge gate.

## Install and switch the host

1. Set the SeoHost A record for `convert-origin` and deploy the controller and Pages project. Configure the matching origin token on the edge and VM. In `/opt/snapotter/secrets`, keep `origin_token` root-owned with mode 0600. Give `idle_token` mode 0444 inside its root-only 0700 parent directory so the unprivileged application can read its mounted secret. Generate independent random tokens of at least 32 bytes.
2. Install `host/compose.override.yaml` and `host/idle-stop.sh` in `/opt/snapotter` and the two unit files in `/etc/systemd/system`. Use an application image that includes the idle listener. Keep the idle timer disabled during setup.
3. During the DNS transition, use both the original public Caddy site and the site in `host/Caddyfile`. The origin health URL must return 403 without the edge token and 200 with it. Associate the public hostname with Pages, then replace the existing `convert` A record with the project CNAME in SeoHost. Verify TLS, Google sign-in at both gates, actual downloads, and the [busy check](host/VERIFY.md). Install `host/Caddyfile` as the final origin-only config after the DNS change takes effect.
4. Enable the idle timer only after you have verified the wake path. Run `systemctl daemon-reload` and `systemctl enable --now snapotter-idle.timer`. After 15 quiet minutes and the next minute's check, the guest requests its own poweroff. A fresh boot automatically restarts Compose. Use a remembered browser to test an entire cold start.

The idle controller listens on the application container's loopback interface. It blocks shutdown while transfers, user jobs or retries are pending, and closes admission before checking the workers again. Unavailable state keeps the VM running. Polling status or leaving a progress stream open does not reset the timer. For maintenance use `systemctl disable --now snapotter-idle.timer` before working. If the VM is already stopped it can always be started in Compute Engine. SSH to the reserved IP during a DNS cutover.

## Roll back

Disable the idle timer first. Restore the public `deploy/convert/Caddyfile` on the VM, reload Caddy and verify HTTPS directly at the reserved IP with the public hostname. Restore the SeoHost `convert` A record to `34.0.249.154`. Keep the origin route serving the edge through the previous DNS TTL. The application can run continuously with the idle timer disabled. Existing backups taken before the wake feature contain the original always-on configuration.
