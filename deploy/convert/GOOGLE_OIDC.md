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
Install `approve-google-user.sh` on the VM. From `/opt/snapotter`, run it
once per approved account before the first Google sign-in. Use the lowercase
primary Gmail address. The script creates an ordinary user without a local
password.

```bash
sudo ./approve-google-user.sh convert-user person@gmail.com
```

For a managed Google Workspace mailbox, independently confirm its identity
and use `--workspace`. Disable the old app account before a Workspace
mailbox is reassigned. Google can mark a third-party address verified even
when its ownership has changed, so only enroll Gmail and confirmed
Google Workspace mailboxes. [Google ID token identity guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

On first sign-in, SnapOtter links the approved row using the verified email.
It looks up linked users by Google subject (`sub`) on later sign-ins.

## Verify the callback

Open `https://convert.henesys.shop`, unlock the wake page if present, then click
**Sign in with Google**. Test with an approved account and check that it reaches
the intended SnapOtter account. In a separate browser session, an unapproved
Google account should be denied after the callback. Check the local admin
password sign-in separately.

The public host serves the OAuth redirect and callback even with the wake
gateway in front. Both the wake cookie and the signed OIDC state cookie use
`SameSite=Lax` so the browser includes them on Google’s top-level GET callback.
The edge forwards the signed app cookie and the callback query to SnapOtter.
