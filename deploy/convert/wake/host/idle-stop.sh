#!/usr/bin/env bash
set -euo pipefail
cd /opt/snapotter

idle_request() {
  docker compose exec -T snapotter node --input-type=module - "$1" <<'JS'
import { readFile } from "node:fs/promises";
const action = process.argv[2];
const token = (await readFile("/run/secrets/idle_token", "utf8")).trim();
const response = await fetch("http://127.0.0.1:13491/api/v1/internal/idle/" + action, {
  method: "POST",
  headers: { Authorization: "Bearer " + token },
  signal: AbortSignal.timeout(18000),
});
if (response.status !== 200) throw new Error("Idle guard returned HTTP " + response.status);
const state = await response.json();
if (action === "check" && state.draining === true && state.idle === true) {
  process.exitCode = 4;
} else if (action !== "cancel" && (state.idle !== true || state.draining !== (action === "drain"))) {
  process.exitCode = 3;
}
JS
}

if idle_request check; then
  # The application rechecks all work under its admission gate during drain.
  :
else
  status=$?
  if (( status == 3 )); then exit 0; fi
  # A killed previous oneshot may have left the admission gate held without
  # requesting shutdown. The timer never overlaps its own oneshot.
  if (( status == 4 )); then
    case "$(systemctl is-system-running || true)" in
      running|degraded) idle_request cancel ;;
    esac
    exit 0
  fi
  exit "$status"
fi

# Also release the gate if the response to a successful drain is lost.
cancel_drain() {
  for attempt in 1 2 3; do
    if idle_request cancel; then return; fi
    sleep 1
  done
}
trap cancel_drain EXIT
idle_request drain
systemctl --no-block poweroff
trap - EXIT
