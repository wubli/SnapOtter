const callbackPath = "/api/auth/oidc/callback";
const startPath = "/_wake/google";
export const googleWakeStateCookieName = "__Host-snapotter-google-state";
const stateLifetimeSeconds = 600;
const providerTimeoutMs = 6000;

// From https://accounts.google.com/.well-known/openid-configuration.
// Pin the endpoints so the client secret is only sent to Google's token endpoint.
const googleIssuer = "https://accounts.google.com";
const authorizationEndpoint = `${googleIssuer}/o/oauth2/v2/auth`;
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const jwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base64url = /^[A-Za-z0-9_-]+$/;
const randomValue = /^[A-Za-z0-9_-]{43}$/;
const taggedState = /^gw\.[A-Za-z0-9_-]{43}$/;

export class GoogleLoginError extends Error {
  constructor(code) {
    super("Google sign-in failed");
    this.code = code;
  }
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value) {
  if (!base64url.test(value) || value.length % 4 === 1) throw new Error("Invalid encoding");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (byte) => byte.charCodeAt(0));
}

function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

function cookieAttributes(value, seconds) {
  return `${googleWakeStateCookieName}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearGoogleWakeStateCookie() {
  return cookieAttributes("", 0);
}

export function isGoogleWakeCallback(request) {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.pathname === callbackPath &&
    url.searchParams.getAll("state").some((value) => value.startsWith("gw."))
  );
}

function stateCookieValue(request) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((field) => field.trim())
    .filter((field) => field.startsWith(`${googleWakeStateCookieName}=`));
  if (values.length !== 1) throw new Error("Invalid state cookie");
  return values[0].slice(googleWakeStateCookieName.length + 1);
}

function isGoogleIssuer(value) {
  return value === googleIssuer || value === "accounts.google.com";
}

async function verifyIdToken(jwt, nonce, clientId, now, fetchImpl, signal, setStage) {
  setStage("token-format");
  if (typeof jwt !== "string" || jwt.length > 16384) throw new Error("Invalid ID token");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const [encodedHeader, encodedClaims, signature] = parts;
  const header = JSON.parse(decoder.decode(decode(encodedHeader)));
  if (
    header?.alg !== "RS256" ||
    header.crit !== undefined ||
    typeof header.kid !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)
  ) {
    throw new Error("Invalid ID token header");
  }

  setStage("key-fetch");
  const response = await fetchImpl(jwksEndpoint, {
    method: "GET",
    redirect: "manual",
    signal,
  });
  if (!response.ok) throw new Error("Google keys unavailable");
  const jwks = await response.json();
  const keys = jwks.keys.filter(
    (key) =>
      key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig",
  );
  setStage("key-unavailable");
  if (keys.length !== 1) throw new Error("Unknown Google key");
  const key = await crypto.subtle.importKey(
    "jwk",
    keys[0],
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  setStage("signature");
  if (
    !(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(signature),
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    ))
  ) {
    throw new Error("Invalid Google signature");
  }

  setStage("claims");
  const claims = JSON.parse(decoder.decode(decode(encodedClaims)));
  const time = Math.floor(now() / 1000);
  if (
    !isGoogleIssuer(claims?.iss) ||
    claims.aud !== clientId ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= time ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > time + 30 ||
    claims.iat >= claims.exp ||
    (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > time)) ||
    claims.nonce !== nonce ||
    typeof claims.sub !== "string" ||
    !/^[!-~]{1,255}$/.test(claims.sub)
  ) {
    throw new Error("Invalid Google identity");
  }
  setStage("email");
  if (
    claims.email_verified !== true ||
    typeof claims.email !== "string" ||
    claims.email.length > 254 ||
    !/^[!-?A-~]+@[A-Za-z0-9.-]+$/.test(claims.email)
  ) {
    throw new Error("Invalid Google identity");
  }
  const email = claims.email.toLowerCase();
  if (
    !email.endsWith("@gmail.com") &&
    !(typeof claims.hd === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(claims.hd))
  ) {
    throw new Error("Google does not manage this mailbox");
  }
  return { sub: claims.sub, email };
}

export function createGoogleLogin(
  { clientId, clientSecret, cookieSecret, publicOrigin },
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const origin = new URL(publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== publicOrigin ||
    typeof clientId !== "string" ||
    !clientId ||
    typeof clientSecret !== "string" ||
    !clientSecret ||
    typeof cookieSecret !== "string" ||
    cookieSecret.length < 32
  ) {
    throw new Error("Invalid Google sign-in configuration");
  }
  const redirectUri = `${origin.origin}${callbackPath}`;
  const additionalData = encoder.encode(`snapotter/google-wake/v1:${redirectUri}:${clientId}`);
  let encryptionKey;
  function stateKey() {
    encryptionKey ??= crypto.subtle
      .digest("SHA-256", encoder.encode(`snapotter/google-wake/state/v1\0${cookieSecret}`))
      .then((key) => crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]));
    return encryptionKey;
  }

  async function start(request) {
    const url = new URL(request.url);
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      request.method !== "POST" ||
      url.origin !== publicOrigin ||
      url.pathname !== startPath ||
      request.headers.get("origin") !== publicOrigin ||
      (fetchSite && fetchSite !== "same-origin")
    ) {
      return new Response("Google sign-in must start on this site.", {
        status: 403,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }

    const state = {
      state: `gw.${randomToken()}`,
      nonce: randomToken(),
      verifier: randomToken(),
      expires: Math.floor(now() / 1000) + stateLifetimeSeconds,
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      await stateKey(),
      encoder.encode(JSON.stringify(state)),
    );
    const challenge = await crypto.subtle.digest("SHA-256", encoder.encode(state.verifier));
    const destination = new URL(authorizationEndpoint);
    destination.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      prompt: "select_account",
      state: state.state,
      nonce: state.nonce,
      code_challenge: encode(new Uint8Array(challenge)),
      code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
      status: 303,
      headers: {
        location: destination.toString(),
        "set-cookie": cookieAttributes(
          `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`,
          stateLifetimeSeconds,
        ),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async function callback(request) {
    let stage = "callback-input";
    try {
      const url = new URL(request.url);
      const states = url.searchParams.getAll("state");
      const codes = url.searchParams.getAll("code");
      const issuers = url.searchParams.getAll("iss");
      if (
        url.origin !== publicOrigin ||
        !isGoogleWakeCallback(request) ||
        states.length !== 1 ||
        !taggedState.test(states[0]) ||
        codes.length !== 1 ||
        !/^[!-~]{1,4096}$/.test(codes[0]) ||
        issuers.length > 1 ||
        (issuers.length === 1 && !isGoogleIssuer(issuers[0])) ||
        url.searchParams.has("error")
      ) {
        throw new Error("Invalid OAuth callback");
      }

      stage = "state-cookie";
      const rawCookie = stateCookieValue(request);
      if (rawCookie.length > 1024) throw new Error("Invalid state cookie");
      const parts = rawCookie.split(".");
      if (parts.length !== 2) throw new Error("Invalid state cookie");
      const [encodedIv, encrypted] = parts;
      const iv = decode(encodedIv);
      if (iv.length !== 12) throw new Error("Invalid state cookie");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData },
        await stateKey(),
        decode(encrypted),
      );
      const state = JSON.parse(decoder.decode(plaintext));
      const time = Math.floor(now() / 1000);
      if (
        state?.state !== states[0] ||
        typeof state.verifier !== "string" ||
        !randomValue.test(state.verifier) ||
        typeof state.nonce !== "string" ||
        !randomValue.test(state.nonce) ||
        !Number.isSafeInteger(state.expires)
      ) {
        throw new Error("Invalid OAuth state");
      }
      stage = "state-expired";
      if (state.expires <= time || state.expires > time + stateLifetimeSeconds) {
        throw new Error("Expired OAuth state");
      }

      stage = "token-exchange";
      const signal = AbortSignal.timeout(providerTimeoutMs);
      const response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: codes[0],
          code_verifier: state.verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
        redirect: "manual",
        signal,
      });
      if (!response.ok) throw new Error("Google token exchange failed");
      const { id_token: token } = await response.json();
      return await verifyIdToken(token, state.nonce, clientId, now, fetchImpl, signal, (value) => {
        stage = value;
      });
    } catch {
      // Errors from fetch, token decoding and crypto may carry callback inputs.
      // Keep them out of the caller's response and logs.
      throw new GoogleLoginError(stage);
    }
  }

  return { start, callback };
}
