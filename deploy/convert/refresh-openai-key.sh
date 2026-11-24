#!/usr/bin/env bash
# Run on the deployment operator's machine with authenticated gcloud and SSH.
set -euo pipefail
umask 077

if [[ ${1:-} == --apply ]]; then
  cd /opt/snapotter
  incoming=$(mktemp secrets/.openai.XXXXXXXX)
  trap '[[ ! -e "$incoming" ]] || unlink "$incoming"' EXIT
  cat > "$incoming"
  [[ -s "$incoming" ]] || { echo "Received an empty secret." >&2; exit 1; }
  mv -- "$incoming" secrets/openai_api_key
  docker compose up -d --no-deps --pull never --force-recreate --wait snapotter
  exit
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [ssh options] user@SnapOtter-host" >&2
  exit 2
fi

# Finish the Secret Manager read before touching the mounted secret.
keyfile=$(mktemp)
trap 'unlink "$keyfile"' EXIT
gcloud secrets versions access latest --secret=snapotter-openai-key \
  --project=convertxx --out-file="$keyfile" --quiet
[[ -s "$keyfile" ]] || { echo "The secret version is empty." >&2; exit 1; }

ssh -o BatchMode=yes "$@" sudo -n /opt/snapotter/refresh-openai-key.sh --apply < "$keyfile"
