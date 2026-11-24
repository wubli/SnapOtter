# Verify wake and idle admission

In a browser, use an approved Google account at the wake gate and in SnapOtter.
Confirm an unapproved Google account is denied in a separate browser session.

For the conversion and OCR smoke tests, copy only the value of
`__Host-snapotter-wake` from the authorized browser's storage inspector into a
private file. The cookie grants edge access until it expires. Use a temporary
file with mode `0600` and remove it after testing. The verifier separately
prompts for the SnapOtter account password, typically the recovery admin's.

```sh
deploy/convert/verify.py --wake-cookie-file /private/path/wake-cookie --skip-ai
```

For an ungated standalone installation, omit `--wake-cookie-file` and
specify its origin with `--url`.

To verify the idle guard, copy `verify-busy.mjs` to the VM. From
`/opt/snapotter`, run the script inside the SnapOtter container. Substitute
the username if it differs from `admin`. Enter the current SnapOtter account
password. The shell reads it without echoing it and passes it into the
container on standard input.

```bash
cd /opt/snapotter
read -rsp 'SnapOtter password: ' smoke_password
printf '\n'
printf '%s\n' "$smoke_password" |
  sudo docker compose exec -T snapotter node --input-type=module -e "$(cat /path/to/verify-busy.mjs)" admin
unset smoke_password
```

The busy test opens a real PNG-to-JPEG upload and withholds its final byte
until the authenticated, loopback-only idle check reports
`{"idle":false,"draining":false,"reason":"requests"}`. It then completes the
conversion and verifies the downloaded JPEG. It only calls the guard's
read-only `check` endpoint and can be run while the idle timer is enabled.
Run it while other origin requests are quiet for a clear baseline.
