import {
  clearGoogleWakeStateCookie,
  createGoogleLogin,
  GoogleLoginError,
  googleWakeStateCookieName,
  isGoogleWakeCallback,
} from "../google-login.js";

const cookieName = "__Host-snapotter-wake";
const cookieLifetime = 7 * 24 * 60 * 60;
const controllerCooldownMs = 10_000;
const healthSuccessMs = 2_000;
const healthFailureMs = 1_000;
const nativeLogin = "/api/auth/oidc/login";
const googleAuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const encoder = new TextEncoder();
const rosterKey = "approved-users-v1";
const rosterTokenHeader = "x-snapotter-roster-token";
const rosterTokenContext = "snapotter-google-roster-v1";
const maxRosterBytes = 256 * 1024;
const maxRosterUsers = 512;
const rosterEmail = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,128}@[a-z0-9.-]{1,190}$/;
const googleSubject = /^[A-Za-z0-9._-]{1,255}$/;
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

function decodeBytes(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
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

function verifiedPrincipal(principal) {
  if (
    !principal ||
    typeof principal.sub !== "string" ||
    !googleSubject.test(principal.sub) ||
    typeof principal.email !== "string" ||
    !rosterEmail.test(principal.email)
  )
    return null;
  return { sub: principal.sub, email: principal.email };
}

function decodeRoster(text) {
  if (
    typeof text !== "string" ||
    text.length > maxRosterBytes ||
    encoder.encode(text).byteLength > maxRosterBytes
  )
    throw new Error("Invalid wake roster");
  const { users, ...other } = JSON.parse(text);
  if (Object.keys(other).length || !Array.isArray(users) || users.length > maxRosterUsers) {
    throw new Error("Invalid wake roster");
  }

  const entries = new Map();
  for (const user of users) {
    if (
      !user ||
      typeof user !== "object" ||
      Object.keys(user).length !== 2 ||
      typeof user.email !== "string" ||
      !rosterEmail.test(user.email) ||
      entries.has(user.email) ||
      (user.sub !== null && (typeof user.sub !== "string" || !googleSubject.test(user.sub)))
    ) {
      throw new Error("Invalid wake roster");
    }
    entries.set(user.email, user.sub);
  }
  return entries;
}

async function isRosterApproved(principal, settings) {
  const users = decodeRoster(await settings.roster.get(rosterKey, { cacheTtl: 30 }));
  const subject = users.get(principal.email);
  return subject === null || subject === principal.sub;
}

async function rememberedPrincipal(request, settings, now) {
  const token = cookieValue(request);
  if (!token) return null;
  const match = /^v2\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, payload, signature] = match;
  try {
    const verified = await crypto.subtle.verify(
      "HMAC",
      await signingKey(settings.cookieSecret),
      decodeBytes(signature),
      encoder.encode(`wake-v2:${settings.publicOrigin}:${payload}`),
    );
    if (!verified) return null;
    const principal = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(payload)),
    );
    const current = Math.floor(now / 1000);
    if (
      !Number.isSafeInteger(principal?.expires) ||
      principal.expires <= current ||
      principal.expires > current + cookieLifetime
    )
      return null;
    return verifiedPrincipal(principal);
  } catch {
    return null;
  }
}

function wakeCookie(value, maxAge) {
  return `${cookieName}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

async function newCookie(principal, settings, now) {
  const expires = Math.floor(now / 1000) + cookieLifetime;
  const payload = base64url(encoder.encode(JSON.stringify({ ...principal, expires })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(settings.cookieSecret),
    encoder.encode(`wake-v2:${settings.publicOrigin}:${payload}`),
  );
  return wakeCookie(`v2.${payload}.${base64url(new Uint8Array(signature))}`, cookieLifetime);
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
    !env.WAKE_GOOGLE_CLIENT_ID ||
    !env.WAKE_GOOGLE_CLIENT_SECRET ||
    typeof env.GOOGLE_WAKE_USERS?.get !== "function" ||
    typeof env.GOOGLE_WAKE_USERS?.put !== "function"
  )
    return null;
  return {
    publicOrigin,
    origin,
    controller,
    originToken: env.ORIGIN_TOKEN,
    controllerToken: env.WAKE_CONTROLLER_TOKEN,
    cookieSecret: env.WAKE_COOKIE_SECRET,
    clientId: env.WAKE_GOOGLE_CLIENT_ID,
    clientSecret: env.WAKE_GOOGLE_CLIENT_SECRET,
    roster: env.GOOGLE_WAKE_USERS,
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

function page(content, script = "", status = 200, cookies = []) {
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
  const headers = noStore({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'nonce-" +
      nonce +
      "'; script-src 'nonce-" +
      nonce +
      "'; connect-src 'self'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
    // Preserve Origin on same-site form POSTs so the wake endpoint can verify it.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status, headers });
}

const googleLoginFailureCopy = {
  "callback-input": "Start Google sign-in again from this page.",
  "state-cookie": "Allow cookies for this site and start Google sign-in again.",
  "state-expired": "The sign-in attempt expired. Start Google sign-in again.",
  "token-exchange": "Google sign-in could not complete. Try again or contact the administrator.",
  "token-format":
    "The Google response could not be verified. Try again or contact the administrator.",
  "key-fetch": "Google verification is temporarily unavailable. Try again shortly.",
  "key-unavailable":
    "The Google response could not be verified. Try again or contact the administrator.",
  signature: "The Google response could not be verified. Try again or contact the administrator.",
  claims: "The Google response could not be verified. Try again or contact the administrator.",
  email: "Use an approved Gmail or Google Workspace account.",
  "roster-unavailable": "Account approval is temporarily unavailable. Try again shortly.",
  "address-not-allowed": "This Google account is not approved. Choose an approved account.",
  "sign-in": "Google sign-in could not complete. Try again or contact the administrator.",
};

function googleFailureReason(error) {
  return error instanceof GoogleLoginError && Object.hasOwn(googleLoginFailureCopy, error.code)
    ? error.code
    : "sign-in";
}

function googleGate({ reason, cookies = [] } = {}) {
  const failure = reason && Object.hasOwn(googleLoginFailureCopy, reason);
  const help = failure
    ? `<p>${googleLoginFailureCopy[reason]}</p><p>Diagnostic: <code>${reason}</code></p>`
    : "<p>Sign in with an approved Google account to start the service.</p>";
  return page(
    "<h1>Open SnapOtter</h1>" +
      help +
      '<form action="/_wake/google" method="post"><button type="submit">Sign in with Google</button></form>',
    "",
    reason === "roster-unavailable" ? 503 : failure ? 403 : 200,
    cookies,
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
      '<p><a href="/login">Use a local SnapOtter account</a></p>',
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

async function publishRoster(request, settings) {
  if (request.method !== "POST") return json(405, "method-not-allowed", { allow: "POST" });
  const token = request.headers.get(rosterTokenHeader);
  if (
    !token ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !(await crypto.subtle.verify(
      "HMAC",
      await signingKey(settings.originToken.trim()),
      Uint8Array.from(token.match(/../g), (byte) => Number.parseInt(byte, 16)),
      encoder.encode(rosterTokenContext),
    ))
  )
    return json(403, "forbidden");

  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return json(415, "unsupported-media-type");
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) return json(400, "invalid-roster");
  if (length !== null && Number(length) > maxRosterBytes) return json(413, "roster-too-large");
  if (!request.body) return json(400, "invalid-roster");

  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxRosterBytes);
  let size = 0;
  let snapshot;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxRosterBytes) {
        await reader.cancel();
        return json(413, "roster-too-large");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    snapshot = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    decodeRoster(snapshot);
  } catch {
    return json(400, "invalid-roster");
  } finally {
    reader.releaseLock();
  }

  try {
    await settings.roster.put(rosterKey, snapshot);
    return new Response(null, { status: 204, headers: noStore() });
  } catch {
    return json(503, "roster-unavailable");
  }
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
      name.startsWith("x-snapotter-roster-") ||
      name.startsWith("x-wake-")
    )
      headers.delete(name);
  }
  const otherCookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(
      (item) =>
        item && ![cookieName, googleWakeStateCookieName].includes(item.split("=")[0].trim()),
    );
  if (otherCookies.length) headers.set("cookie", otherCookies.join("; "));
  else headers.delete("cookie");
  headers.set("x-snapotter-origin-token", settings.originToken);
  headers.set("x-forwarded-host", new URL(settings.publicOrigin).host);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

const bypassCache = { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } };

function createWorker(fetchUpstream = fetch, now = Date.now, googleLogin = createGoogleLogin) {
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

      if (path === "/_wake/roster") return publishRoster(request, settings);
      if (isGoogleWakeCallback(request)) {
        const clearState = clearGoogleWakeStateCookie();
        let principal;
        try {
          principal = verifiedPrincipal(
            await googleLogin(settings, { fetchImpl: fetchUpstream, now }).callback(request),
          );
        } catch (error) {
          return googleGate({ reason: googleFailureReason(error), cookies: [clearState] });
        }
        if (!principal) return googleGate({ reason: "sign-in", cookies: [clearState] });
        try {
          if (!(await isRosterApproved(principal, settings))) {
            return googleGate({ reason: "address-not-allowed", cookies: [clearState] });
          }
        } catch {
          return googleGate({ reason: "roster-unavailable", cookies: [clearState] });
        }
        const headers = noStore({ location: nativeLogin });
        headers.append("set-cookie", clearState);
        headers.append("set-cookie", await newCookie(principal, settings, now()));
        if (!(await ready(settings))) await requestWake(settings);
        return new Response(null, { status: 303, headers });
      }
      if (path === "/_wake/google") {
        if (request.method !== "POST") return json(405, "method-not-allowed", { allow: "POST" });
        if (!sameOrigin(request, settings)) return json(403, "forbidden");
        if (!(await hasEmptyBody(request))) return json(400, "invalid-request");
        try {
          const response = await googleLogin(settings, { fetchImpl: fetchUpstream, now }).start(
            request,
          );
          return new Response(response.body, {
            status: response.status,
            headers: noStore(response.headers),
          });
        } catch (error) {
          return googleGate({ reason: googleFailureReason(error) });
        }
      }
      const navigation = acceptsPage(request);
      let remembered = await rememberedPrincipal(request, settings, now());
      if (remembered) {
        try {
          if (!(await isRosterApproved(remembered, settings))) remembered = null;
        } catch {
          return navigation
            ? googleGate({ reason: "roster-unavailable" })
            : json(503, "roster-unavailable");
        }
      }
      if (path === "/_wake") return handleWake(request, settings, remembered);
      if (path === "/_wake/status") {
        if (request.method !== "GET") return json(405, "method-not-allowed", { allow: "GET" });
        if (!remembered) return json(401, "unauthorized");
        return (await ready(settings))
          ? json(200, "ready")
          : json(503, "waiting", { "retry-after": "3" });
      }
      if (path.startsWith("/_wake/")) return json(404, "not-found");

      if (!remembered) {
        return navigation
          ? googleGate({ cookies: cookieValue(request) ? [wakeCookie("", 0)] : [] })
          : json(401, "unauthorized");
      }
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
      headers.delete(rosterTokenHeader);
      if (path === "/api/auth/logout" && request.method === "POST" && response.ok) {
        headers.append("set-cookie", wakeCookie("", 0));
      }
      const location = headers.get("location");
      if (location) {
        try {
          const redirect = new URL(location, settings.origin);
          if (
            url.pathname === nativeLogin &&
            request.method === "GET" &&
            redirect.origin + redirect.pathname === googleAuthorizationEndpoint
          ) {
            redirect.searchParams.set("login_hint", remembered.email);
            headers.set("location", redirect.href);
          } else if (redirect.origin === settings.origin) {
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
