# Verify wake and idle admission

From a workstation, unlock the edge gateway, wait for SnapOtter to start, and
run the local conversion and OCR checks. Supply the team passphrase via a
private file. The verifier prompts for the SnapOtter account password.

```sh
deploy/convert/verify.py --wake-passphrase-file /path/to/wake-passphrase --skip-ai
```

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
