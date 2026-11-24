import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const metadataUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const instanceUrl =
  "https://compute.googleapis.com/compute/v1/projects/convertxx/zones/europe-central2-b/instances/snapotter";
const startGraceMs = 15_000;
const retrySeconds = 3;

const digest = (value) => createHash("sha256").update(value).digest();

function classify(status) {
  switch (status) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STAGING":
    case "REPAIRING":
      return "starting";
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    case "TERMINATED":
      return null;
    default:
      throw new Error("Unexpected VM state");
  }
}

async function fetchJson(fetchImpl, url, { headers, method, timeoutMs, operation }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      method,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Error(`${operation}: network error or timeout`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${operation}: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation}: invalid response`);
  }
}

export function createWakeServer({ token, fetchImpl = fetch, now = Date.now } = {}) {
  const sharedToken = token?.trim();
  if (!sharedToken || !/^[A-Za-z0-9._~+/-]+=*$/.test(sharedToken)) {
    throw new Error("WAKE_CONTROLLER_TOKEN must contain a bearer token");
  }
  const expected = digest(sharedToken);
  let inFlight;
  let startAttempt;

  async function wake() {
    const credentials = await fetchJson(fetchImpl, metadataUrl, {
      headers: { "Metadata-Flavor": "Google" },
      timeoutMs: 2_000,
      operation: "Metadata OAuth token",
    });
    if (typeof credentials?.access_token !== "string" || !credentials.access_token) {
      throw new Error("Metadata OAuth token: missing access token");
    }
    const headers = { Authorization: `Bearer ${credentials.access_token}` };
    const getState = async () => {
      const instance = await fetchJson(fetchImpl, `${instanceUrl}?fields=status`, {
        headers,
        timeoutMs: 3_000,
        operation: "Compute instances.get",
      });
      return classify(instance?.status);
    };

    const state = await getState();
    if (state) {
      if (state !== "starting") startAttempt = undefined;
      return state;
    }
    if (startAttempt?.expiresAt > now() && startAttempt.accepted) return "starting";

    // Reuse the UUID after a lost response. A fresh UUID after the grace period
    // allows another wake if an earlier operation never started the VM.
    if (!startAttempt || startAttempt.expiresAt <= now()) {
      startAttempt = { id: randomUUID(), expiresAt: now() + startGraceMs, accepted: false };
    }
    try {
      const operation = await fetchJson(fetchImpl, `${instanceUrl}/start?requestId=${startAttempt.id}`, {
        headers,
        method: "POST",
        timeoutMs: 3_000,
        operation: "Compute instances.start",
      });
      if (operation?.error || !["PENDING", "RUNNING", "DONE"].includes(operation?.status)) {
        throw new Error("Compute instances.start: invalid or failed operation");
      }
      startAttempt.accepted = true;
      startAttempt.expiresAt = now() + startGraceMs;
      return "starting";
    } catch (error) {
      // Another controller or operator may have started or stopped the VM
      // between the GET and POST. Re-read the state; let the caller retry if
      // there is no observed transition.
      const observed = await getState().catch(() => null);
      if (observed) {
        if (observed !== "starting") startAttempt = undefined;
        return observed;
      }
      throw error;
    }
  }

  function reply(response, status, body, headers = {}) {
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  return createServer(async (request, response) => {
    if (request.url !== "/wake") return reply(response, 404, { error: "not_found" });
    if (request.method !== "POST") {
      return reply(response, 405, { error: "method_not_allowed" }, { Allow: "POST" });
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(request.headers.authorization ?? "");
    if (!match || !timingSafeEqual(expected, digest(match[1]))) {
      return reply(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    }

    inFlight ??= wake()
      .catch((error) => {
        console.error("Wake request failed:", error.message);
        return null;
      })
      .finally(() => { inFlight = undefined; });

    const state = await inFlight;
    if (state === "running") return reply(response, 200, { state });
    const retry = { "Retry-After": String(retrySeconds) };
    if (!state) return reply(response, 503, { error: "temporarily_unavailable" }, retry);
    return reply(response, 202, { state }, retry);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  createWakeServer({ token: process.env.WAKE_CONTROLLER_TOKEN }).listen(port, "0.0.0.0");
}
