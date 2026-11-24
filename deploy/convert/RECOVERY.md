# Convert deployment recovery copy

Run the cold copy from the Docker host. Keep the backup directory on a separate mounted disk when available. It contains the database, queued jobs, uploads and artifacts, TLS keys, and all deployment credentials. Keep it private and encrypt it before moving it off host.

```bash
cd /opt/snapotter
docker compose stop --timeout 60 caddy snapotter
docker compose stop --timeout 60 postgres redis
sudo ./recovery-copy.sh /opt/snapotter "/root/snapotter-convert-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose up -d --pull never
```

Keep the project stopped until the script finishes. It checks free space, reads each Compose volume and the deployment configuration into compressed archives, compares each archive against its source, and verifies a SHA-256 manifest. It publishes the backup directory after those checks succeed. The source archive includes the pinned image references. Keep those exact images available in a registry or a separate image export.

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
