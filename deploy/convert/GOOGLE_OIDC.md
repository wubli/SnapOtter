# Google sign-in for Convert

## Create the Google OAuth client

1. In the `convertxx` Google Cloud project, open **Google Auth platform**.
   Configure **Branding** and choose an **Audience**. **Internal** applies only
   to members of the associated Google organization. Select **External** if
   the intended users include personal Gmail accounts.
2. In **Clients**, create an OAuth client of type **Web application**. Add this
   exact **Authorized redirect URI**.

   ```text
   https://convert.henesys.shop/api/auth/oidc/callback
   ```

3. Use the basic identity scopes `openid email`. The server-side
   flow uses the redirect URI and does not require an Authorized JavaScript
   origin or access to additional Google APIs.

Google’s External Testing allowlist exempts the basic identity scopes. SnapOtter
controls who receives a local session. [Google OAuth app states](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)

[Google web application OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## Configure the VM

In `/opt/snapotter`:

1. Install `compose.google-oidc.yaml` next to `compose.yaml` and
   `compose.override.yaml`.
2. Install `install-google-oidc-client.py` in `/opt/snapotter`. Retrieve
   the original Web client JSON from the `snapotter-google-oauth-client`
   Secret Manager secret in `convertxx` into a private temporary file.
   Pass that file on standard input.

   ```bash
   sudo python3 ./install-google-oidc-client.py < /private/path/google-web-client.json
   ```

   The installer writes the client ID as `OIDC_CLIENT_ID` in
   `secrets/google-oidc-current/client.env` and the client secret in the
   sibling `client_secret` file. It switches both files together. The
   container entrypoint reads the mounted secret at startup.
3. Keep the OAuth overlay in the deployment’s Compose file order so later
   service recreations retain Google sign-in. Add this to `.env`.

   ```dotenv
   COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.google-oidc.yaml
   ```

   For a deployment without the wake gateway, leave
   `compose.override.yaml` out of the list.

4. Run `sudo docker compose config --quiet` to check the combined files and
   `sudo docker compose up -d --no-deps --wait snapotter` to apply them.

PostgreSQL retains account links and the app’s cookie-signing secret across
container restarts. Include the OAuth overlay and mounted secret in protected
deployment backups. To rotate the Google client secret, run the installer with
the new Web client JSON and run
`sudo docker compose up -d --no-deps --force-recreate --wait snapotter`.

## Account access

The overlay disables Google account creation and uses the existing password
admin for recovery. Keep the original admin account independent of Google.
Before publishing the initial wake roster, confirm at least one approved
Google account can pass the gate so the existing local recovery admin can
reach `/login`. The database migration preserves prior operator-approved
accounts, including a previously approved account whose role is now admin.
For a fresh deployment, use `approve-google-user.sh USERNAME PRIMARY_GOOGLE_EMAIL`
from `/opt/snapotter` to seed the first approved account. Keep that account
separate from the local recovery admin.

After bootstrap, sign in as an administrator and use **Settings → People** to
approve Google users. Enter the exact lowercase
primary Gmail address or a confirmed Google Workspace mailbox. Disable or
remove a user here to revoke wake access as well as app access.

The host publishes these approvals each minute. Allow about two minutes for
the timer and Pages KV propagation to reflect an add or revocation. To publish
immediately from the VM, run `sudo /opt/snapotter/sync-wake-roster.py --force`.
[Wake roster setup](wake/README.md)

Disable the old app account before a Workspace mailbox is reassigned. Google
can mark a third-party address verified even when its ownership has changed.
[Google ID token identity guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

On first sign-in, SnapOtter links the approved row using the verified email.
It looks up linked users by Google subject (`sub`) on later sign-ins.

## Verify the callback

At `https://convert.henesys.shop`, use **Sign in with Google** at the wake gate.
After SnapOtter is ready, complete native Google sign-in with the same account.
Check that it reaches the intended SnapOtter account. In a separate browser
session, an account without an active Google approval should be denied before
it can wake the host.

Check the local admin password separately in an authorized browser by opening
`/login` directly. If you cannot pass the edge gate during recovery, start the
VM in Compute Engine and SSH to the host. From `/opt/snapotter`, inspect
account recovery status through the container CLI.

```bash
sudo docker compose exec snapotter sh -ec '
  export OIDC_CLIENT_SECRET="$(cat "$OIDC_CLIENT_SECRET_FILE")"
  exec snapotter-admin "$@"
' sh status
```

Pass a recovery subcommand in place of `status` when needed. The public edge
continues to require Google. [SnapOtter account recovery commands](https://docs.snapotter.com/guide/account-recovery)

The edge and SnapOtter use the same exact public OAuth callback. The worker
recognizes the state for its own flow and forwards SnapOtter's callback query
and signed state cookie to the app. The wake and OAuth state cookies use
`SameSite=Lax` for Google's top-level GET callbacks. [Pages bindings and deployment](wake/pages/README.md)
