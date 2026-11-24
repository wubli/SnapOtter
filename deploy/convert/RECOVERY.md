# Convert deployment recovery copy

Run the cold copy from the Docker host. Keep the backup directory on a separate mounted disk when available. It contains the database, queued jobs, uploads and artifacts, TLS keys, and all deployment credentials. Keep it private and encrypt it before moving it off host.

```bash
cd /opt/snapotter
docker compose stop --timeout 60 caddy snapotter
docker compose stop --timeout 60 postgres redis
sudo ./recovery-copy.sh /opt/snapotter "/root/snapotter-convert-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose up -d --pull never
```

Keep the project stopped until the script finishes. It checks free space, reads each Compose volume and the deployment configuration into compressed archives, compares each archive against its source, and verifies a SHA-256 manifest. It publishes the backup directory after those checks succeed. The deployment archive includes the Google OAuth overlay when the resolved Compose configuration enables OIDC and mounts the Google client secret. The source archive includes the pinned image references. Keep those exact images available in a registry or a separate image export.

## Retrieve a November 24 recovery copy

The private Cloud Storage bucket holds the original `recovery-20261124.tar.gpg` and the wake-enabled `recovery-wake-20261124.tar.gpg`. Both use version 1 of the `snapotter-backup-passphrase` secret in `convertxx`. On a trusted Linux recovery machine with GnuPG and both read permissions, run the following in Bash. The destination must be new and have room for the encrypted file and the extracted archives.

```bash
set -euo pipefail
umask 077
mkdir -m 700 snapotter-recovery-20261124
cd snapotter-recovery-20261124
archive=recovery-wake-20261124.tar.gpg
gcloud storage cp --project=convertxx \
  "gs://convertxx-snapotter-recovery-604983748882/$archive" .
keyfile=$(mktemp /dev/shm/snapotter-recovery.XXXXXXXX)
trap 'unlink "$keyfile"' EXIT
gcloud secrets versions access 1 --project=convertxx \
  --secret=snapotter-backup-passphrase --out-file="$keyfile"
gpg --batch --pinentry-mode loopback --passphrase-file "$keyfile" \
  --decrypt "$archive" | tar -xf -
sha256sum --check SHA256SUMS
unlink "$keyfile"
trap - EXIT
```

Use the extracted directory as `backup` in the restore procedure below. The archives include credentials and private TLS keys.

## Restore into an isolated Compose project

Use a fresh directory and Compose project name on a Linux Docker host with the matching local images available. Run these commands as root to preserve file owners and permissions. Restore into new volumes so the existing project stays intact.

```bash
set -euo pipefail
umask 077
backup=/root/snapotter-convert-YYYYMMDDTHHMMSSZ
restore=/opt/snapotter-recovery
project=snapotter-convert-recovery
(cd "$backup" && sha256sum --check --status SHA256SUMS)
mkdir -m 700 -- "$restore"
tar_opts=(--numeric-owner --same-owner --same-permissions --acls --xattrs --xattrs-include='*')
tar "${tar_opts[@]}" -xzf "$backup/deployment.tar.gz" -C "$restore"

compose=(docker compose --project-name "$project" --project-directory "$restore" -f "$restore/compose.yaml")
if [[ -f "$restore/compose.override.yaml" ]]; then
  compose+=(-f "$restore/compose.override.yaml")
fi
if [[ -f "$restore/compose.google-oidc.yaml" ]]; then
  compose+=(-f "$restore/compose.google-oidc.yaml")
fi
volume_list=$("${compose[@]}" config --volumes)
while IFS= read -r key; do
  volume="${project}_${key}"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    printf 'Restore volume already exists: %s\n' "$volume" >&2
    exit 1
  fi
done <<< "$volume_list"

while IFS= read -r key; do
  volume="${project}_${key}"
  docker volume create \
    --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.volume=$key" "$volume" >/dev/null
  mountpoint=$(docker volume inspect --format '{{ .Mountpoint }}' "$volume")
  tar "${tar_opts[@]}" -xzf "$backup/volume-$key.tar.gz" -C "$mountpoint"
  tar "${tar_opts[@]}" -dzf "$backup/volume-$key.tar.gz" -C "$mountpoint" >/dev/null
done <<< "$volume_list"

"${compose[@]}" up -d --wait --pull never postgres redis
"${compose[@]}" exec -T postgres psql -U snapotter -d snapotter -v ON_ERROR_STOP=1 \
  -c 'SELECT count(*) FROM public.users;'
"${compose[@]}" exec -T redis redis-cli ping
"${compose[@]}" stop
```

PostgreSQL and Redis have no published ports. The database query and Redis ping verify that both restored services can read their state. Start Caddy and SnapOtter only when the restore should serve traffic and ports 80 and 443 are available. To resume an interrupted restore, use another fresh project name and directory.

When returning the wake-enabled copy to production, restore the stack at `/opt/snapotter` and install the two systemd unit files from the [wake deployment guide](wake/README.md). Verify the protected origin and public gateway before enabling the idle timer. If replacing the VM, reapply the controller service account’s VM-level start permission and attach the reserved origin address.

## Rotate the OpenAI key

Add a version to the `snapotter-openai-key` secret in the `convertxx` project. The VM reads a protected file when the application container starts. Run the following helper from an operator machine with access to the secret and SSH access to the VM. Pass the same SSH identity options and destination used for deployment. Install the matching helper in `/opt/snapotter/` when restoring a new VM.

```bash
deploy/convert/refresh-openai-key.sh -i ~/.ssh/snapotter-convertxx-deploy snapdeploy@34.0.249.154
```

The helper reads the latest secret version, replaces the root-owned file and recreates the application container. The production key needs access to `POST /v1/audio/transcriptions` for `gpt-transcribe`. For subtitles, SnapOtter detects pauses in the local audio and requests a transcript for each clip of up to eight seconds. Each cue uses the clip's position on the original audio timeline. Background noise can make pause detection less precise, and continuous speech is split near low-energy points.
