#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if (( $# != 2 )); then
  fail "Usage: sudo $0 DEPLOYMENT_DIRECTORY NEW_BACKUP_DIRECTORY"
fi
(( EUID == 0 )) || fail "Run as root to read Docker volumes and preserve ownership."

deployment_dir=$(realpath -e -- "$1")
backup_parent=$(realpath -e -- "$(dirname -- "$2")")
destination="$backup_parent/$(basename -- "$2")"
[[ ! -e "$destination" && ! -L "$destination" ]] || fail "Backup directory already exists."

project=snapotter-convert
compose=(docker compose --project-name "$project" --project-directory "$deployment_dir" -f "$deployment_dir/compose.yaml")
config_files=(compose.yaml Caddyfile .env secrets)
if [[ -f "$deployment_dir/compose.override.yaml" ]]; then
  compose+=(-f "$deployment_dir/compose.override.yaml")
  config_files+=(compose.override.yaml idle-stop.sh)
  if [[ -f "$deployment_dir/sync-wake-roster.py" ]]; then
    config_files+=(sync-wake-roster.py)
  fi
fi
if [[ -f "$deployment_dir/compose.google-oidc.yaml" ]]; then
  # Resolve the operator's default Compose stack, including any COMPOSE_FILE
  # setting. Keep the rendered model in the pipe and skip service env files.
  oauth_active=$(
    cd "$deployment_dir"
    docker compose --project-name "$project" config --no-env-resolution --format json 2>/dev/null |
      python3 -c '
import json, sys

model = json.load(sys.stdin)
app = model["services"]["snapotter"]
enabled = app.get("environment", {}).get("OIDC_ENABLED") == "true"
mounted = any(secret.get("source") == "google_oidc_client_secret" for secret in app.get("secrets", []))
print("true" if enabled and mounted else "false")
' 2>/dev/null
  ) || fail "Could not determine Google OIDC activation from the deployment's Compose configuration."
  if [[ "$oauth_active" == true ]]; then
    compose+=(-f "$deployment_dir/compose.google-oidc.yaml")
    config_files+=(compose.google-oidc.yaml)
  fi
fi
for config_file in "${config_files[@]}"; do
  [[ -e "$deployment_dir/$config_file" ]] || fail "Missing deployment file: $config_file"
done

require_stopped() {
  local containers
  containers=$(docker ps -q --filter "label=com.docker.compose.project=$project")
  [[ -z "$containers" ]] || fail "Stop the Compose project before taking a recovery copy."
  for volume in "${volumes[@]}"; do
    containers=$(docker ps -q --filter "volume=$volume")
    [[ -z "$containers" ]] || fail "A running container still uses volume $volume."
  done
}

volume_list=$("${compose[@]}" config --volumes)
[[ -n "$volume_list" ]] || fail "Compose returned no declared volumes."
mapfile -t volume_keys <<< "$volume_list"
volumes=()
mountpoints=()
for key in "${volume_keys[@]}"; do
  [[ "$key" =~ ^[a-zA-Z0-9_-]+$ ]] || fail "Invalid Compose volume key."
  volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$key")
  [[ -n "$volume" && "$volume" != *$'\n'* ]] || fail "Expected one volume for $key."
  mountpoint=$(docker volume inspect --format '{{ .Mountpoint }}' "$volume")
  [[ "$mountpoint" = /* && -d "$mountpoint" ]] || fail "Volume $volume is not accessible on this host."
  [[ "$backup_parent/" != "$mountpoint/"* ]] || fail "Choose a destination outside Docker volumes."
  volumes+=("$volume")
  mountpoints+=("$mountpoint")
done
[[ "$backup_parent/" != "$deployment_dir/secrets/"* ]] || fail "Choose a destination outside the secrets directory."
require_stopped

# Allow for tar headers and gzip overhead using apparent sizes before compression.
source_bytes=$(cd "$deployment_dir" && du -sb -- "${config_files[@]}" "${mountpoints[@]}" | awk '{ total += $1 } END { printf "%.0f", total }')
free_bytes=$(df -B1 --output=avail -- "$backup_parent" | awk 'NR == 2 { print $1 }')
(( free_bytes >= source_bytes + source_bytes / 20 + 64 * 1024 * 1024 )) ||
  fail "Insufficient free space for an uncompressed-size recovery copy."

staging=$(mktemp -d -- "$backup_parent/.snapotter-recovery.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
tar_metadata=(--numeric-owner --acls --xattrs --xattrs-include='*')
archives=(deployment.tar.gz)

archive_and_compare() {
  local archive=$1 directory=$2
  shift 2
  tar "${tar_metadata[@]}" --sparse -I 'gzip -1' -cf "$staging/$archive" -C "$directory" -- "$@"
  tar "${tar_metadata[@]}" -dzf "$staging/$archive" -C "$directory" >/dev/null
}

archive_and_compare deployment.tar.gz "$deployment_dir" "${config_files[@]}"
for index in "${!volume_keys[@]}"; do
  archive="volume-${volume_keys[index]}.tar.gz"
  archive_and_compare "$archive" "${mountpoints[index]}" .
  archives+=("$archive")
done
require_stopped
(
  cd "$staging"
  sha256sum -- "${archives[@]}" > SHA256SUMS
  sha256sum --check --status SHA256SUMS
)
[[ ! -e "$destination" && ! -L "$destination" ]] || fail "Backup directory already exists."
mv -T -- "$staging" "$destination"
trap - EXIT
printf 'Verified recovery copy at %s\n' "$destination"
