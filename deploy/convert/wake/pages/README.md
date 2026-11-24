# SnapOtter wake edge

This Pages Advanced Mode worker owns the public HTTPS hostname. It serves a small gate without contacting the VM when a visitor has no valid wake cookie. Only Google accounts in the published SnapOtter roster can wake the VM. SnapOtter verifies its own user session separately using native Google OIDC. Use the same approved Google account for both steps.

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
| GOOGLE_WAKE_USERS | Workers KV namespace binding declared in the Wrangler file. The host publishes the approved roster under approved-users-v1. |

The Google OAuth client must authorize `https://convert.henesys.shop/api/auth/oidc/callback`, shared with native SnapOtter login. Use the same web client pair on the edge and VM. The edge handles its own OAuth state and forwards the native SnapOtter callback to the origin. [Create and configure the Google OAuth client](../../GOOGLE_OIDC.md)

The wake cookie is signed for the public origin, identifies an approved Google user, and expires after seven days. The worker checks the KV roster whenever it authorizes a Google callback or a wake cookie and strips the cookie before proxying. Keep production bindings outside the checkout and deployment assets. Retire the old `WAKE_PASSPHRASE` binding after the Google gate deploys. Passphrase-era cookies require a new Google sign-in.

## Local verification

Run these commands from this directory.

~~~sh
npm test
~~~

The fixtures exercise Google authorization, authenticated roster publication, revocation and subject matching, cross-origin rejection, cookie expiry and tampering, cold navigation, passive status polling, stop-in-progress retries, origin header handling and a single streaming upload. They use synthetic data and no cloud resources.

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
5. Publish the initial approved roster from the running VM with the host sync helper. The gateway denies access until the roster is published. See the [wake deployment guide](../README.md) for host setup.
6. Open the public site in a fresh browser. Sign in to the gate with an approved account, wait for SnapOtter, and complete its Google sign-in with the same account. Verify a conversion. Check with a separate, unapproved Google account that the gate denies access without waking the VM. Once the host stops, reopen the public site with the approved browser and verify the remembered session starts it automatically. Confirm unauthenticated health checks and uploads leave the VM stopped.

## Roster publication

The VM posts the full JSON snapshot to `/_wake/roster` using `Content-Type: application/json`. The `X-SnapOtter-Roster-Token` header contains the lowercase hex HMAC-SHA256 of `snapotter-google-roster-v1` using the trimmed origin token as the key. The gateway accepts up to 512 distinct lowercase email addresses in 256 KiB. Each record contains `email` and `sub`. A null subject allows the verified email to sign in before SnapOtter links it to a Google subject. Once a subject is published, both fields must match. An empty roster revokes everyone.

The gateway acknowledges a snapshot with HTTP 204 after Workers KV accepts the write. A missing or unreadable roster blocks admission. Workers KV uses regional caching and is eventually consistent. The edge requests the minimum 30-second cache TTL, so roster changes can take time to reach all regions. The app independently checks its own user access. [Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## Request flow

A same-origin `POST /_wake/google` sends the browser to Google. The edge validates Google's callback and issues its signed wake cookie only to an approved account. It then sends the browser to native SnapOtter login, where the approved email is supplied to Google as an account hint. SnapOtter authorizes its own session. An authorized browser can send an empty same-origin `POST /_wake` to start the VM. While a stop finishes, the waiting page can retry. `GET /_wake/status` checks readiness without starting the VM.

Ordinary authenticated writes require a fresh readiness probe before the incoming stream is forwarded. Cold writes receive 503 without forwarding the body. The worker does not retry or replay requests. The origin still needs to reject requests during the race between a successful readiness probe and the start of draining.
