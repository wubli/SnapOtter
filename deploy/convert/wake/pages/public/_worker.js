const cookieName = "__Host-snapotter-wake";
const cookieLifetime = 7 * 24 * 60 * 60;
const controllerCooldownMs = 10_000;
const healthSuccessMs = 2_000;
const healthFailureMs = 1_000;
const maxUnlockBytes = 2048;
const encoder = new TextEncoder();
const deniedPaths = ["/_internal", "/internal", "/api/internal", "/api/v1/internal"];
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function signatureBytes(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return Uint8Array.from(atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`), (char) =>
    char.charCodeAt(0),
  );
}

async function signingKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function cookieValue(request) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
}

async function isRemembered(request, settings, now) {
  const token = cookieValue(request);
  if (!token) return false;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  const current = Math.floor(now / 1000);
  if (expires <= current || expires > current + cookieLifetime) return false;
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(settings.cookieSecret),
    signatureBytes(match[2]),
    encoder.encode(`cookie:${settings.publicOrigin}:${expires}`),
  );
}

async function newCookie(settings, now) {
  const expires = Math.floor(now / 1000) + cookieLifetime;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(settings.cookieSecret),
    encoder.encode(`cookie:${settings.publicOrigin}:${expires}`),
  );
  return (
    cookieName +
    "=v1." +
    expires +
    "." +
    base64url(new Uint8Array(signature)) +
    "; Max-Age=" +
    cookieLifetime +
    "; Path=/; Secure; HttpOnly; SameSite=Lax"
  );
}

function parseHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function configuration(env) {
  const publicOrigin = parseHttpsOrigin(env.PUBLIC_ORIGIN);
  const origin = parseHttpsOrigin(env.ORIGIN_URL);
  const controller = parseHttpsOrigin(env.WAKE_CONTROLLER_URL);
  if (
    !publicOrigin ||
    !origin ||
    !controller ||
    origin === publicOrigin ||
    controller === publicOrigin ||
    controller === origin ||
    !env.ORIGIN_TOKEN ||
    !env.WAKE_CONTROLLER_TOKEN ||
    encoder.encode(env.WAKE_COOKIE_SECRET ?? "").length < 32 ||
    encoder.encode(env.WAKE_PASSPHRASE ?? "").length < 24
  )
    return null;
  return {
    publicOrigin,
    origin,
    controller,
    originToken: env.ORIGIN_TOKEN,
    controllerToken: env.WAKE_CONTROLLER_TOKEN,
    cookieSecret: env.WAKE_COOKIE_SECRET,
    passphrase: env.WAKE_PASSPHRASE,
  };
}

function noStore(headers = {}) {
  const result = new Headers(headers);
  result.set("cache-control", "private, no-store, max-age=0");
  result.set("cdn-cache-control", "no-store");
  result.set("cloudflare-cdn-cache-control", "no-store");
  result.delete("surrogate-control");
  return result;
}

function json(status, state, headers) {
  return Response.json({ state }, { status, headers: noStore(headers) });
}

function classifyPath(pathname) {
  // Ambiguous encoded delimiters can be interpreted differently by the proxy and origin.
  if (/%(?:25|2e|2f|5c|00)/i.test(pathname)) return null;
  let normalized;
  try {
    normalized = decodeURIComponent(pathname).toLowerCase().replace(/\/+/g, "/");
  } catch {
    return null;
  }
  if (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject ambiguous URL delimiters.
    /[\u0000-\u001f\u007f\\]/.test(normalized) ||
    deniedPaths.some((path) => normalized === path || normalized.startsWith(`${path}/`))
  )
    return null;
  if ((normalized === "/_wake" || normalized.startsWith("/_wake/")) && pathname !== normalized)
    return null;
  return normalized;
}

function acceptsPage(request) {
  const mode = request.headers.get("sec-fetch-mode");
  return (
    request.method === "GET" &&
    (mode === "navigate" ||
      (!mode &&
        request.headers
          .get("accept")
          ?.split(",")
          .some((part) => part.trim().split(";")[0] === "text/html")))
  );
}

function page(content, script = "") {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
  const html =
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>SnapOtter</title>" +
    '<style nonce="' +
    nonce +
    '">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f7;color:#17333a;font:16px system-ui}main{box-sizing:border-box;width:min(90vw,30rem);padding:2rem;border:1px solid #cedbdb;border-radius:1rem;background:white}h1{margin-top:0}input,button{box-sizing:border-box;padding:.7rem;font:inherit;border-radius:.4rem}input{width:100%;margin:.5rem 0 1rem;border:1px solid #85999a}button{background:#176266;color:white;border:0;cursor:pointer}a{color:#176266}form{margin-top:1rem}</style>' +
    "<main>" +
    content +
    "</main>" +
    (script ? `<script nonce="${nonce}">${script}</script>` : "") +
    "</html>";
  return new Response(html, {
    headers: noStore({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'nonce-" +
        nonce +
        "'; script-src 'nonce-" +
        nonce +
        "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      // Preserve Origin on same-site form POSTs so the wake endpoint can verify it.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    }),
  });
}

function unlockPage() {
  return page(
    "<h1>Open SnapOtter</h1><p>Enter the team passphrase to start the service.</p>" +
      '<form action="/_wake" method="post"><label for="passphrase">Team passphrase</label>' +
      '<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required>' +
      '<button type="submit">Continue</button></form>',
  );
}

const waitingScript = [
  'const status = document.getElementById("status");',
  "const deadline = Date.now() + 180000;",
  "let nextWake = 0;",
  "async function poll() {",
  '  if (Date.now() >= deadline) { status.textContent = "SnapOtter is still unavailable. Reload to try again."; return; }',
  "  try {",
  "    if (Date.now() >= nextWake) {",
  "      nextWake = Date.now() + 12000;",
  '      const wake = await fetch("/_wake", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(12000) });',
  "      if (wake.status === 401) { location.reload(); return; }",
  "    }",
  '    const response = await fetch("/_wake/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });',
  "    if (response.status === 401) { location.reload(); return; }",
  '    if (response.ok && (await response.json()).state === "ready") { location.reload(); return; }',
  "  } catch {}",
  "  setTimeout(poll, 3000);",
  "}",
  "void poll();",
].join("\n");

function waitingPage() {
  return page(
    '<h1>Starting SnapOtter</h1><p id="status" role="status">This page will open when the service is ready.</p>' +
      '<noscript><form action="/_wake" method="post"><button type="submit">Start SnapOtter</button></form></noscript>',
    waitingScript,
  );
}

function sameOrigin(request, settings) {
  return (
    request.headers.get("origin") === settings.publicOrigin &&
    (!request.headers.has("sec-fetch-site") ||
      request.headers.get("sec-fetch-site") === "same-origin")
  );
}

async function unlockForm(request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded" || !request.body) return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxUnlockBytes)) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxUnlockBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    const entries = [...new URLSearchParams(body + decoder.decode())];
    if (entries.length === 0) return {};
    return entries.length === 1 && entries[0][0] === "passphrase"
      ? { passphrase: entries[0][1] }
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function hasEmptyBody(request) {
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") return false;
  if (!request.body) return true;

  // Cloudflare can expose a zero-byte POST as a stream. Inspect only enough
  // to detect EOF or reject the first nonempty chunk.
  const reader = request.body.getReader();
  try {
    for (let reads = 0; reads < 8; reads++) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength > 0) break;
    }
    await reader.cancel();
    return false;
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function validPassphrase(input, settings) {
  if (input === undefined) return false;
  const key = await signingKey(settings.cookieSecret);
  const correct = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`pass:${settings.passphrase}`),
  );
  return crypto.subtle.verify("HMAC", key, correct, encoder.encode(`pass:${input}`));
}

function proxyHeaders(request, settings) {
  const headers = new Headers(request.headers);
  for (const token of (headers.get("connection") ?? "").split(",")) {
    const name = token.trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) headers.delete(name);
  }
  for (const name of hopHeaders) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (
      name === "host" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-snapotter-origin-") ||
      name.startsWith("x-wake-")
    )
      headers.delete(name);
  }
  const otherCookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && item.split("=")[0].trim() !== cookieName);
  if (otherCookies.length) headers.set("cookie", otherCookies.join("; "));
  else headers.delete("cookie");
  headers.set("x-snapotter-origin-token", settings.originToken);
  headers.set("x-forwarded-host", new URL(settings.publicOrigin).host);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

const bypassCache = { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } };

function createWorker(fetchUpstream = fetch, now = Date.now) {
  let health;
  let wake;

  async function ready(settings, fresh = false) {
    if (!fresh && health?.origin === settings.origin && health.until > now()) return health.ok;
    let ok = false;
    try {
      const response = await fetchUpstream(`${settings.origin}/api/v1/health`, {
        headers: { "x-snapotter-origin-token": settings.originToken, accept: "application/json" },
        redirect: "manual",
        cache: "no-store",
        cf: bypassCache,
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) ok = (await response.json()).status === "healthy";
      else await response.body?.cancel();
    } catch {}
    health = {
      origin: settings.origin,
      until: now() + (ok ? healthSuccessMs : healthFailureMs),
      ok,
    };
    return ok;
  }

  async function requestWake(settings) {
    if (wake?.controller === settings.controller && wake.until > now()) return wake.state;
    // Share only the cooldown result. Worker isolates cannot share fetch I/O
    // across requests, and the controller deduplicates across isolates.
    const attempt = {
      controller: settings.controller,
      until: now() + controllerCooldownMs,
      state: "starting",
    };
    wake = attempt;
    let state = "unavailable";
    try {
      const response = await fetchUpstream(`${settings.controller}/wake`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.controllerToken}`,
          accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const data = await response.json();
        if (["starting", "running", "stopping"].includes(data.state)) state = data.state;
      } else await response.body?.cancel();
    } catch {}
    attempt.state = state;
    return state;
  }

  async function handleWake(request, settings, remembered) {
    if (request.method !== "POST") return json(405, "method-not-allowed", { allow: "POST" });
    if (!sameOrigin(request, settings)) return json(403, "forbidden");
    const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type === "application/x-www-form-urlencoded") {
      const form = request.body ? await unlockForm(request) : {};
      if (
        !form ||
        ((!remembered || form.passphrase !== undefined) &&
          !(await validPassphrase(form.passphrase, settings)))
      ) {
        return json(401, "unauthorized");
      }
      if (!(await ready(settings))) await requestWake(settings);
      const headers = noStore({ location: "/" });
      if (!remembered) headers.set("set-cookie", await newCookie(settings, now()));
      return new Response(null, { status: 303, headers });
    }
    if (!remembered) return json(401, "unauthorized");
    if (!(await hasEmptyBody(request))) return json(400, "invalid-request");
    if (await ready(settings)) return json(200, "ready");
    const state = await requestWake(settings);
    return json(state === "unavailable" ? 503 : 202, state, { "retry-after": "10" });
  }

  return {
    async fetch(request, env) {
      const settings = configuration(env);
      if (!settings) return json(503, "unavailable");
      const url = new URL(request.url);
      if (url.origin !== settings.publicOrigin) return json(404, "not-found");
      const path = classifyPath(url.pathname);
      if (!path) return json(404, "not-found");

      const remembered = await isRemembered(request, settings, now());
      if (path === "/_wake") return handleWake(request, settings, remembered);
      if (path === "/_wake/status") {
        if (request.method !== "GET") return json(405, "method-not-allowed", { allow: "GET" });
        if (!remembered) return json(401, "unauthorized");
        return (await ready(settings))
          ? json(200, "ready")
          : json(503, "waiting", { "retry-after": "3" });
      }
      if (path.startsWith("/_wake/")) return json(404, "not-found");

      const navigation = acceptsPage(request);
      if (!remembered) return navigation ? unlockPage() : json(401, "unauthorized");
      const canWrite = request.method !== "GET" && request.method !== "HEAD";
      if (!(await ready(settings, canWrite))) {
        return navigation ? waitingPage() : json(503, "waiting", { "retry-after": "3" });
      }

      let response;
      try {
        response = await fetchUpstream(settings.origin + url.pathname + url.search, {
          method: request.method,
          signal: request.signal,
          headers: proxyHeaders(request, settings),
          ...(request.body && { body: request.body, duplex: "half" }),
          redirect: "manual",
          cache: "no-store",
          cf: bypassCache,
        });
      } catch {
        health = undefined;
        return navigation ? waitingPage() : json(503, "unavailable", { "retry-after": "3" });
      }
      if ([502, 503, 504, 521, 522, 523, 524].includes(response.status)) {
        health = undefined;
        if (navigation) {
          await response.body?.cancel();
          return waitingPage();
        }
      }
      const headers = noStore(response.headers);
      headers.delete("x-snapotter-origin-token");
      const location = headers.get("location");
      if (location) {
        try {
          const redirect = new URL(location, settings.origin);
          if (redirect.origin === settings.origin) {
            headers.set(
              "location",
              settings.publicOrigin + redirect.pathname + redirect.search + redirect.hash,
            );
          }
        } catch {}
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

export { createWorker };
export default createWorker();
