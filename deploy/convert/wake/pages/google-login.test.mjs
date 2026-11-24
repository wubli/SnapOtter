import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  clearGoogleWakeStateCookie,
  createGoogleLogin,
  GoogleLoginError,
  googleWakeStateCookieName,
  isGoogleWakeCallback,
} from "./google-login.js";

const settings = {
  clientId: "registered-client.apps.googleusercontent.com",
  clientSecret: "test-server-only-value",
  cookieSecret: "test-state-cookie-secret-long-enough",
  publicOrigin: "https://convert.example.test",
};
const callback = `${settings.publicOrigin}/api/auth/oidc/callback`;
const startUrl = `${settings.publicOrigin}/_wake/google`;
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const jwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const startTime = 1_800_000_000_000;
const keyId = "fixture-key-id";
const encoder = new TextEncoder();
const nonExpiredClaims = {
  iss: "https://accounts.google.com",
  aud: settings.clientId,
  exp: startTime / 1000 + 600,
  iat: startTime / 1000,
  sub: "google-subject-123",
  email: "Approved@GMAIL.COM",
  email_verified: true,
};
let keys;
let jwk;

before(async () => {
  keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: keyId,
    alg: "RS256",
    use: "sig",
  };
});

async function fixture({ claims, failAt, invalidSignature = false } = {}) {
  let timestamp = startTime;
  let destination;
  const calls = [];
  const deps = {
    now: () => timestamp,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      if (url === tokenEndpoint) {
        if (failAt === "token") return new Response(null, { status: 502 });
        if (failAt === "token-redirect") return Response.redirect(jwksEndpoint);
        assert.equal(init.method, "POST");
        assert.equal(init.body.get("client_secret"), settings.clientSecret);
        assert.equal(init.body.get("client_id"), settings.clientId);
        assert.equal(init.body.get("code"), "google-code");
        assert.equal(init.body.get("redirect_uri"), callback);
        const challenge = await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(init.body.get("code_verifier")),
        );
        assert.equal(
          Buffer.from(challenge).toString("base64url"),
          destination.searchParams.get("code_challenge"),
        );
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: keyId })).toString(
          "base64url",
        );
        const body = Buffer.from(
          JSON.stringify({
            ...nonExpiredClaims,
            nonce: destination.searchParams.get("nonce"),
            ...claims,
          }),
        ).toString("base64url");
        const signature = Buffer.from(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys.privateKey,
            encoder.encode(`${header}.${body}`),
          ),
        );
        if (invalidSignature) signature[0] ^= 1;
        return Response.json({ id_token: `${header}.${body}.${signature.toString("base64url")}` });
      }
      if (url === jwksEndpoint) {
        if (failAt === "keys") return new Response(null, { status: 503 });
        if (failAt === "key-redirect") return Response.redirect(tokenEndpoint);
        return Response.json({ keys: [jwk] });
      }
      throw new Error("Unexpected outbound request");
    },
  };
  const login = createGoogleLogin(settings, deps);
  const response = await login.start(
    new Request(startUrl, {
      method: "POST",
      headers: { origin: settings.publicOrigin, "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie");
  destination = new URL(response.headers.get("location"));
  const state = destination.searchParams.get("state");
  const callbackUrl = `${callback}?${new URLSearchParams({ code: "google-code", state })}`;
  return {
    login,
    cookie,
    destination,
    calls,
    state,
    response,
    deps,
    setTime: (value) => (timestamp = value),
    callbackRequest: (url = callbackUrl, value = cookie.split(";")[0]) =>
      new Request(url, { headers: { cookie: value } }),
    callbackUrl,
  };
}

test("starts a same-origin authorization flow and exchanges it for a verified identity", async () => {
  const { login, cookie, destination, calls, response, callbackRequest, state } = await fixture();
  assert.match(state, /^gw\.[A-Za-z0-9_-]{43}$/);
  assert.match(cookie, /Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(destination.origin, "https://accounts.google.com");
  assert.equal(destination.searchParams.get("redirect_uri"), callback);
  assert.equal(destination.searchParams.get("scope"), "openid email");
  assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
  assert.equal(destination.searchParams.has("code_verifier"), false);
  assert.equal(destination.toString().includes(settings.clientSecret), false);
  assert.equal(cookie.includes(state), false);
  assert.equal(isGoogleWakeCallback(callbackRequest()), true);
  assert.deepEqual(await login.callback(callbackRequest()), {
    sub: "google-subject-123",
    email: "approved@gmail.com",
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    [tokenEndpoint, jwksEndpoint],
  );
  assert.equal(calls[0].init.signal, calls[1].init.signal);
  assert.match(
    clearGoogleWakeStateCookie(),
    new RegExp(`^${googleWakeStateCookieName}=; Max-Age=0;`),
  );
});

test("only lets first-party POST requests initiate login", async () => {
  const login = createGoogleLogin(settings);
  for (const request of [
    new Request(startUrl),
    new Request(startUrl, { method: "POST" }),
    new Request(startUrl, { method: "POST", headers: { origin: "https://other.example.test" } }),
    new Request(startUrl, {
      method: "POST",
      headers: { origin: settings.publicOrigin, "sec-fetch-site": "cross-site" },
    }),
  ]) {
    assert.equal((await login.start(request)).status, 403);
  }
});

test("preserves native callback dispatch and rejects mismatched state before exchanging a code", async () => {
  const { login, calls, callbackRequest, callbackUrl, cookie } = await fixture();
  assert.equal(
    isGoogleWakeCallback(new Request(`${callback}?state=native-state&code=native-code`)),
    false,
  );
  assert.equal(isGoogleWakeCallback(new Request(`${startUrl}?state=gw.wrong-path`)), false);
  const url = new URL(callbackUrl);
  url.searchParams.append("state", "native-state");
  const ambiguous = callbackRequest(url);
  assert.equal(isGoogleWakeCallback(ambiguous), true);
  const changedCookie = cookie
    .split(";")[0]
    .replace(/=(.)/, (_match, initial) => `=${initial === "A" ? "B" : "A"}`);
  for (const request of [
    ambiguous,
    callbackRequest(`${callback}?code=google-code&state=gw.${"A".repeat(43)}`),
    callbackRequest(callbackUrl, ""),
    callbackRequest(callbackUrl, changedCookie),
    callbackRequest(`${callbackUrl}&iss=https://other.example.test`),
  ]) {
    await assert.rejects(login.callback(request), /^Error: Google sign-in failed$/);
  }
  assert.equal(calls.length, 0);
});

test("expires state and binds it to the configured OAuth client", async () => {
  const { login, calls, callbackRequest, setTime, deps } = await fixture();
  const otherClient = createGoogleLogin({ ...settings, clientId: "other-client" }, deps);
  await assert.rejects(otherClient.callback(callbackRequest()), {
    code: "state-cookie",
  });
  setTime(startTime + 600_000);
  await assert.rejects(login.callback(callbackRequest()), { code: "state-expired" });
  assert.equal(calls.length, 0);
});

test("requires a Google-hosted, verified address and returns a normalized Workspace identity", async () => {
  const workspace = await fixture({
    claims: { email: "Member@workspace.example", hd: "workspace.example" },
  });
  assert.equal(
    (await workspace.login.callback(workspace.callbackRequest())).email,
    "member@workspace.example",
  );

  for (const claims of [
    { email: "member@third-party.example" },
    { email_verified: false },
    { email_verified: "true" },
  ]) {
    const { login, callbackRequest } = await fixture({ claims });
    await assert.rejects(login.callback(callbackRequest()), /Google sign-in failed/);
  }
});

test("checks signed identity claims and keeps provider failures out of caller errors", async () => {
  for (const claims of [
    { iss: "https://other.example.test" },
    { aud: "unrelated-app" },
    { azp: "unrelated-app" },
    { exp: startTime / 1000 },
    { nonce: "another-flow" },
    { sub: "" },
  ]) {
    const { login, callbackRequest } = await fixture({ claims });
    await assert.rejects(login.callback(callbackRequest()), /^Error: Google sign-in failed$/);
  }
  for (const [options, code] of [
    [{ failAt: "token" }, "token-exchange"],
    [{ failAt: "token-redirect" }, "token-exchange"],
    [{ failAt: "keys" }, "key-fetch"],
    [{ failAt: "key-redirect" }, "key-fetch"],
    [{ invalidSignature: true }, "signature"],
  ]) {
    const { login, callbackRequest, calls } = await fixture(options);
    await assert.rejects(
      login.callback(callbackRequest()),
      (error) =>
        error instanceof GoogleLoginError &&
        error.message === "Google sign-in failed" &&
        error.code === code &&
        error.cause === undefined,
    );
    assert.equal(calls.length, code === "token-exchange" ? 1 : 2);
  }
});
