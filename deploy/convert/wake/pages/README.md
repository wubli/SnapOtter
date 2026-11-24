# SnapOtter wake edge

This Pages Advanced Mode worker owns the public HTTPS hostname. It serves a small gate without contacting the VM when a visitor has no valid wake cookie. Only Google accounts on the edge allowlist can wake the VM. SnapOtter verifies its own user session separately using native Google OIDC. Use the same approved Google account for both steps.

| Binding | Configuration |
| --- | --- |
| PUBLIC_ORIGIN | Public HTTPS origin. Set in the Wrangler file. |
| ORIGIN_URL | Token-protected, DNS-only VM HTTPS origin. Set in the Wrangler file. |
| WAKE_CONTROLLER_URL | Cloud Run HTTPS origin without a path. Configure as a Pages secret binding so project configuration does not replace it. |
| WAKE_CONTROLLER_TOKEN | Same server-side token the controller checks in the Bearer header. |
| ORIGIN_TOKEN | Same token the origin proxy checks in X-SnapOtter-Origin-Token. |
| WAKE_COOKIE_SECRET | Independent random signing secret of at least 32 UTF-8 bytes. Rotating it immediately invalidates existing wake cookies. |
| WAKE_GOOGLE_CLIENT_ID | Google OAuth Web client ID used by the VM. |
| WAKE_GOOGLE_CLIENT_SECRET | Matching Google OAuth client secret. Set as a Pages production secret. |
| WAKE_GOOGLE_ALLOWED_EMAILS | Comma-delimited exact, lowercase primary Google email addresses approved to use Convert. Store the list in a Pages production secret and enroll the same users in SnapOtter. |

The Google OAuth client must authorize `https://convert.henesys.shop/api/auth/oidc/callback`, shared with native SnapOtter login. Use the same web client pair on the edge and VM. The edge handles its own OAuth state and forwards the native SnapOtter callback to the origin. [Create and configure the Google OAuth client](../../GOOGLE_OIDC.md)

The wake cookie is signed for the public origin, identifies an approved Google user, and expires after seven days. The worker checks the allowlist on every request and strips the cookie before proxying. Keep production bindings outside the checkout and deployment assets. Retire the old `WAKE_PASSPHRASE` binding after the Google gate deploys. Passphrase-era cookies require a new Google sign-in.

## Local verification

Run these commands from this directory.

~~~sh
npm test
~~~

The fixtures exercise Google authorization, cross-origin rejection, cookie expiry and tampering, cold navigation, passive status polling, stop-in-progress retries, origin header handling and a single streaming upload. They use synthetic data and no cloud resources.

## Deploy

1. Bring up the origin on the reserved address first. Its HTTPS hostname uses a DNS-only record and its proxy must reject requests lacking the correct token. Verify that a direct request without the token returns 403 and that the authenticated health route reports healthy when accepting work. The health route must return 503 while the host drains.
2. Deploy the wake controller and verify its authenticated POST /wake contract. It returns 200 with a running state or 202 with a starting or stopping state. The controller is responsible for deduplicating requests across edge isolates.
3. Create the Direct Upload Pages project if it does not exist. Set the project name and production branch to match the target project.

~~~sh
npx wrangler pages project create snapotter-convert-wake --production-branch main --force
npx wrangler pages secret bulk "$WAKE_PAGES_SECRET_FILE" --project-name snapotter-convert-wake
npx wrangler pages deploy public --project-name snapotter-convert-wake --branch main
~~~

Wrangler 4.168 uses `--force` during project creation to select the Pages service that supports an external DNS subdomain. The secret file is a protected JSON object containing the bindings listed above that are absent from the Wrangler file. Use the dashboard's production secret settings if the project is managed with dashboard credentials. Keep `public/` limited to `_worker.js`. Wrangler bundles its imported helper source from outside `public/` during deployment. [Cloudflare Pages Advanced Mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) · [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/)

4. Associate convert.henesys.shop with the Pages project as a custom domain, then switch the public DNS to Pages. Keep convert-origin.henesys.shop pointing to the reserved VM address. Bypass response caching for both hostnames. Preview or pages.dev requests return 404 because the worker requires the configured public origin.
5. Open the public site in a fresh browser. Sign in to the gate with an approved account, wait for SnapOtter, and complete its Google sign-in with the same account. Verify a conversion. Check with a separate, unapproved Google account that the gate denies access without waking the VM. Once the host stops, reopen the public site with the approved browser and verify the remembered session starts it automatically. Confirm unauthenticated health checks and uploads leave the VM stopped.

## Request flow

A same-origin `POST /_wake/google` sends the browser to Google. The edge validates Google's callback and issues its signed wake cookie only to an approved account. It then sends the browser to native SnapOtter login, where the approved email is supplied to Google as an account hint. SnapOtter authorizes its own session. An authorized browser can send an empty same-origin `POST /_wake` to start the VM. While a stop finishes, the waiting page can retry. `GET /_wake/status` checks readiness without starting the VM.

Ordinary authenticated writes require a fresh readiness probe before the incoming stream is forwarded. Cold writes receive 503 without forwarding the body. The worker does not retry or replay requests. The origin still needs to reject requests during the race between a successful readiness probe and the start of draining.
