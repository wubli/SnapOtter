# SnapOtter wake edge

This Pages Advanced Mode worker owns the public HTTPS hostname. It serves a small gate without contacting the VM when a visitor has no valid wake cookie. The team passphrase is independent of the SnapOtter login and only grants access to the edge. SnapOtter still authenticates its own users.

| Binding | Configuration |
| --- | --- |
| PUBLIC_ORIGIN | Public HTTPS origin. Set in the Wrangler file. |
| ORIGIN_URL | Token-protected, DNS-only VM HTTPS origin. Set in the Wrangler file. |
| WAKE_CONTROLLER_URL | Cloud Run HTTPS origin without a path. Configure as a Pages secret binding so project configuration does not replace it. |
| WAKE_CONTROLLER_TOKEN | Same server-side token the controller checks in the Bearer header. |
| ORIGIN_TOKEN | Same token the origin proxy checks in X-SnapOtter-Origin-Token. |
| WAKE_COOKIE_SECRET | Independent random signing secret of at least 32 UTF-8 bytes. Rotating it immediately invalidates existing wake cookies. |
| WAKE_PASSPHRASE | Independent randomly generated team passphrase of at least 24 UTF-8 bytes. Keep it in a Pages secret and share it through the team's password manager. |

The cookie is signed for the public origin and expires after seven days. The worker strips it before proxying. Use different values for all four secrets. Do not save production bindings in the checkout or deploy them as static assets.

## Local verification

Run these commands from this directory.

~~~sh
npm test
~~~

The fixtures exercise unlock, cross-origin rejection, cookie expiry and tampering, cold navigation, passive status polling, stop-in-progress retries, origin header handling and a single streaming upload. They use synthetic data and no cloud resources.

## Deploy

1. Bring up the origin on the reserved address first. Its HTTPS hostname uses a DNS-only record and its proxy must reject requests lacking the correct token. Verify that a direct request without the token returns 403 and that the authenticated health route reports healthy when accepting work. The health route must return 503 while the host drains.
2. Deploy the wake controller and verify its authenticated POST /wake contract. It returns 200 with a running state or 202 with a starting or stopping state. The controller is responsible for deduplicating requests across edge isolates.
3. Create the Direct Upload Pages project if it does not exist. Set the project name and production branch to match the target project.

~~~sh
npx wrangler pages project create snapotter-convert-wake --production-branch main --force
npx wrangler pages secret bulk "$WAKE_PAGES_SECRET_FILE" --project-name snapotter-convert-wake
npx wrangler pages deploy public --project-name snapotter-convert-wake --branch main
~~~

Wrangler 4.168 uses `--force` during project creation to select the Pages service that supports an external DNS subdomain. The secret file is a protected JSON object with the five bindings named above that are absent from the Wrangler file. Use the dashboard's production secret settings if the project is managed with dashboard credentials. The public directory contains only the advanced-mode worker bundle. [Cloudflare Pages Advanced Mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) · [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/)

4. Associate convert.henesys.shop with the Pages project as a custom domain, then switch the public DNS to Pages. Keep convert-origin.henesys.shop pointing to the reserved VM address. Bypass response caching for both hostnames. Preview or pages.dev requests return 404 because the worker requires the configured public origin.
5. Open the public site in a fresh browser and verify the team gate appears. Unlock it, wait for the login form, and verify a conversion. Once the host stops, reopen the public site with the same browser and verify the remembered session starts it automatically. Confirm an unauthorized HTTP health check or upload does not start the VM. Keep the separate SnapOtter login enabled.

## Request flow

POST /_wake is same-origin and accepts a small URL-encoded passphrase form or an empty request with the signed cookie. Only this action calls the controller. A remembered browser navigation to a cold service serves a waiting page that posts immediately and retries at intervals of at least 12 seconds for up to three minutes. This lets a stop in progress finish before the next start attempt. GET /_wake/status checks origin readiness without waking the VM.

Ordinary authenticated writes require a fresh readiness probe before the incoming stream is forwarded. Cold writes receive 503 without forwarding the body. The worker does not retry or replay requests. The origin still needs to reject requests during the race between a successful readiness probe and the start of draining.
