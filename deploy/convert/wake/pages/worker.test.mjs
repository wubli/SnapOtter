import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { GoogleLoginError } from "./google-login.js";
import { createWorker } from "./public/_worker.js";

const env = {
  PUBLIC_ORIGIN: "https://convert.example.test",
  ORIGIN_URL: "https://origin.example.test",
  WAKE_CONTROLLER_URL: "https://controller.example.test",
  WAKE_CONTROLLER_TOKEN: "controller-fixture-token",
  ORIGIN_TOKEN: "origin-fixture-token",
  WAKE_COOKIE_SECRET: "fixture-signer-secret-thirty-two-bytes",
  WAKE_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com",
  WAKE_GOOGLE_CLIENT_SECRET: "fixture-google-client-secret",
};

const rosterKey = "approved-users-v1";
const approvedEmail = "approved@gmail.com";
const rosterToken = createHmac("sha256", env.ORIGIN_TOKEN.trim())
  .update("snapotter-google-roster-v1")
  .digest("hex");

function scenario() {
  let healthy = false;
  let availableAt = 1_800_000_000_000;
  let state = "starting";
  let snapshot = JSON.stringify({ users: [{ email: approvedEmail, sub: null }] });
  let kvFailure = false;
  const puts = [];
  const environment = {
    ...env,
    GOOGLE_WAKE_USERS: {
      async get(key, options) {
        assert.equal(key, rosterKey);
        assert.equal(options.cacheTtl, 30);
        if (kvFailure) throw new Error("fixture KV failure");
        return snapshot;
      },
      async put(key, value) {
        assert.equal(key, rosterKey);
        if (kvFailure) throw new Error("fixture KV failure");
        puts.push(value);
        snapshot = value;
      },
    },
  };
  const calls = [];
  const googleCalls = [];
  const callbackPath = "/api/auth/oidc/callback";
  const worker = createWorker(
    async (url, init) => {
      calls.push({ body: init.body, headers: new Headers(init.headers), method: init.method, url });
      if (url === `${env.WAKE_CONTROLLER_URL}/wake`) return Response.json({ state });
      if (url === `${env.ORIGIN_URL}/api/v1/health`) {
        return Response.json(
          { status: healthy ? "healthy" : "unavailable" },
          { status: healthy ? 200 : 503 },
        );
      }
      if (url === `${env.ORIGIN_URL}/api/auth/oidc/login`) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://accounts.google.com/o/oauth2/v2/auth?state=app-state",
            "set-cookie": "oidc-state=app-state",
          },
        });
      }
      if (url === `${env.ORIGIN_URL}/api/auth/logout`) {
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": "app-session=; Max-Age=0" } },
        );
      }
      if (url.endsWith("/redirect")) {
        return new Response(null, {
          status: 303,
          headers: { location: `${env.ORIGIN_URL}/destination` },
        });
      }
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("file"));
            stream.close();
          },
        }),
        {
          headers: {
            "cache-control": "public, max-age=3600",
            "set-cookie": "app-session=keep",
            "x-snapotter-origin-token": "must-not-leak",
          },
        },
      );
    },
    () => availableAt,
    () => ({
      async start() {
        googleCalls.push("start");
        return new Response(null, {
          status: 303,
          headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?state=gw.fixture" },
        });
      },
      async callback(request) {
        googleCalls.push("callback");
        const code = new URL(request.url).searchParams.get("code");
        if (code === "invalid") throw new Error("synthetic arbitrary exception with private value");
        if (
          [
            "state-cookie",
            "state-expired",
            "token-exchange",
            "key-fetch",
            "signature",
            "email",
          ].includes(code)
        )
          throw new GoogleLoginError(code);
        return {
          sub: "123456",
          email: code === "approved" ? "approved@gmail.com" : "other@gmail.com",
        };
      },
    }),
  );

  function request(path, init, overrides) {
    return worker.fetch(new Request(env.PUBLIC_ORIGIN + path, init), {
      ...environment,
      ...overrides,
    });
  }

  function callback(code = "approved") {
    return request(`${callbackPath}?state=gw.fixture&code=${code}`);
  }

  function publish(body, token = rosterToken, overrides) {
    return request(
      "/_wake/roster",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-snapotter-roster-token": token },
        body,
        ...(body instanceof ReadableStream && { duplex: "half" }),
      },
      overrides,
    );
  }

  return {
    calls,
    googleCalls,
    puts,
    environment,
    publish,
    roster(value) {
      snapshot = value;
    },
    failKv() {
      kvFailure = true;
    },
    request,
    callback,
    advance(ms) {
      availableAt += ms;
    },
    healthy(value) {
      healthy = value;
    },
    controller(value) {
      state = value;
    },
  };
}

const navigation = { accept: "text/html", "sec-fetch-mode": "navigate" };
const fromBrowser = { origin: env.PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" };

async function cookieFor(fixture) {
  const response = await fixture.callback();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/api/auth/oidc/login");
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-snapotter-wake="));
  assert.match(cookie, /^__Host-snapotter-wake=v2\.([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_-]{43};/);
  assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  return cookie.split(";")[0];
}

test("only approved Google callbacks or remembered same-origin wake can contact the controller", async () => {
  const f = scenario();
  const gate = await f.request("/", { headers: navigation });
  assert.equal(gate.headers.get("referrer-policy"), "same-origin");
  assert.match(await gate.text(), /Sign in with Google/);
  assert.equal((await f.request("/api/v1/health")).status, 401);
  assert.equal((await f.request("/_wake/status")).status, 401);
  assert.equal(
    (
      await f.request("/_wake", {
        method: "POST",
        headers: fromBrowser,
        body: new URLSearchParams({ passphrase: "legacy" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/_wake/google", {
        method: "POST",
        headers: { origin: "https://elsewhere.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/_wake/google", { method: "POST", headers: fromBrowser })).status,
    303,
  );
  assert.equal((await f.callback("denied")).status, 403);
  assert.equal((await f.callback("invalid")).status, 403);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.googleCalls, ["start", "callback", "callback"]);

  const cookie = await cookieFor(f);
  const wakes = f.calls.filter(({ url }) => url.endsWith("/wake"));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].method, "POST");
  assert.equal(wakes[0].headers.get("authorization"), `Bearer ${env.WAKE_CONTROLLER_TOKEN}`);
  assert.equal(wakes[0].headers.get("cookie"), null);
  assert.equal(
    (
      await f.request("/_wake", {
        method: "POST",
        headers: { cookie, origin: "https://elsewhere.example" },
      })
    ).status,
    403,
  );
});

test("Google failures show only vetted diagnostics and never wake the host", async () => {
  const f = scenario();
  const cases = [
    ["state-cookie", /Allow cookies/],
    ["state-expired", /attempt expired/],
    ["token-exchange", /sign-in could not complete/],
    ["key-fetch", /temporarily unavailable/],
    ["signature", /could not be verified/],
    ["email", /approved Gmail or Google Workspace account/],
    ["denied", /account is not approved/],
    ["invalid", /sign-in could not complete/],
  ];
  for (const [code, help] of cases) {
    const response = await f.callback(code);
    assert.equal(response.status, 403);
    assert.match(response.headers.get("set-cookie"), /^__Host-snapotter-google-state=; Max-Age=0/);
    const html = await response.text();
    assert.match(html, help);
    const expected =
      code === "denied" ? "address-not-allowed" : code === "invalid" ? "sign-in" : code;
    assert.ok(html.includes(`<code>${expected}</code>`));
    assert.doesNotMatch(
      html,
      /gw\.fixture|other@gmail\.com|synthetic arbitrary exception with private value/,
    );
  }
  assert.deepEqual(f.calls, []);
});

test("legacy cookies are cleared and v2 cookies honor expiry, signature and current approval", async () => {
  const f = scenario();
  f.healthy(true);
  const legacy = `__Host-snapotter-wake=v1.1800000010.${"x".repeat(43)}`;
  const gate = await f.request("/", { headers: { ...navigation, cookie: legacy } });
  assert.match(await gate.text(), /Sign in with Google/);
  assert.match(gate.headers.get("set-cookie"), /__Host-snapotter-wake=; Max-Age=0/);
  assert.equal(
    (await f.request("/_wake", { method: "POST", headers: { ...fromBrowser, cookie: legacy } }))
      .status,
    401,
  );
  const cookie = await cookieFor(f);
  const tampered = cookie.replace(/v2\.[A-Za-z0-9_-]+\./, "v2.e30.");
  assert.equal((await f.request("/", { headers: { cookie: tampered } })).status, 401);
  f.roster(JSON.stringify({ users: [] }));
  assert.equal(
    (await f.request("/_wake", { method: "POST", headers: { ...fromBrowser, cookie } })).status,
    401,
  );
  f.roster(JSON.stringify({ users: [{ email: approvedEmail, sub: null }] }));
  f.advance(7 * 24 * 60 * 60_000);
  assert.equal((await f.request("/", { headers: { cookie } })).status, 401);
  assert.equal(f.calls.length, 1);
});

test("authenticated roster publication validates bounds and always writes the snapshot", async () => {
  const f = scenario();
  const snapshot = JSON.stringify({ users: [{ email: approvedEmail, sub: null }] });
  assert.equal((await f.request("/_wake/roster")).status, 405);
  assert.equal((await f.publish(snapshot, "wrong")).status, 403);
  assert.equal((await f.publish(snapshot, rosterToken.toUpperCase())).status, 403);
  assert.equal((await f.publish(snapshot, rosterToken, { ORIGIN_TOKEN: "different" })).status, 403);
  for (const payload of [
    "null",
    JSON.stringify({ users: [{ email: approvedEmail }] }),
    JSON.stringify({ users: [{ email: "UPPERCASE@gmail.com", sub: null }] }),
    JSON.stringify({ users: [{ email: approvedEmail, sub: "a space" }] }),
    JSON.stringify({
      users: [
        { email: approvedEmail, sub: null },
        { email: approvedEmail, sub: "123" },
      ],
    }),
    JSON.stringify({
      users: Array.from({ length: 513 }, (_, i) => ({ email: `u${i}@example.test`, sub: null })),
    }),
  ])
    assert.equal((await f.publish(payload)).status, 400);
  const tooLarge = new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array(256 * 1024 + 1));
      stream.close();
    },
  });
  assert.equal((await f.publish(tooLarge)).status, 413);
  assert.deepEqual(f.puts, []);
  for (let i = 0; i < 2; i++) {
    const response = await f.publish(snapshot, rosterToken, {
      ORIGIN_TOKEN: ` ${env.ORIGIN_TOKEN}\n`,
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  assert.deepEqual(f.puts, [snapshot, snapshot]);
  assert.deepEqual(f.calls, []);
  f.failKv();
  assert.equal((await f.publish(snapshot)).status, 503);
});

test("published subject binding and revocation apply to existing wake cookies", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  const current = () => f.request("/_wake/status", { headers: { cookie } });
  assert.equal((await current()).status, 200);
  assert.equal(
    (await f.publish(JSON.stringify({ users: [{ email: approvedEmail, sub: "123456" }] }))).status,
    204,
  );
  assert.equal((await current()).status, 200);
  assert.equal(
    (await f.publish(JSON.stringify({ users: [{ email: approvedEmail, sub: "wrong-subject" }] })))
      .status,
    204,
  );
  assert.equal((await current()).status, 401);
  assert.equal((await f.callback()).status, 403);
  assert.equal((await f.publish(JSON.stringify({ users: [] }))).status, 204);
  assert.equal(
    (await f.request("/_wake", { method: "POST", headers: { ...fromBrowser, cookie } })).status,
    401,
  );
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/wake")).length, 0);
});

test("missing, malformed or unavailable roster fails closed", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  const wake = (overrides) =>
    f.request("/_wake", { method: "POST", headers: { ...fromBrowser, cookie } }, overrides);
  assert.equal((await wake({ GOOGLE_WAKE_USERS: undefined })).status, 503);
  for (const snapshot of [null, "malformed"]) {
    f.roster(snapshot);
    assert.deepEqual(await (await wake()).json(), { state: "roster-unavailable" });
    const callback = await f.callback();
    assert.equal(callback.status, 503);
    assert.match(await callback.text(), /roster-unavailable/);
    assert.equal(callback.headers.getSetCookie().length, 1);
  }
  f.failKv();
  const response = await wake();
  assert.equal(response.status, 503);
  assert.equal(f.calls.length, 1);
});

test("native OIDC uses the preferred Google identity, preserves callbacks and clears the edge session on logout", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);

  const appLogin = await f.request("/api/auth/oidc/login", { headers: { cookie } });
  const authorization = new URL(appLogin.headers.get("location"));
  assert.equal(authorization.searchParams.get("state"), "app-state");
  assert.equal(authorization.searchParams.get("login_hint"), "approved@gmail.com");
  assert.equal(appLogin.headers.get("set-cookie"), "oidc-state=app-state");

  const callback = "/api/auth/oidc/callback?state=app-state&code=example";
  const appCallback = await f.request(callback, {
    headers: {
      cookie: `${cookie}; oidc-state=app-state; __Host-snapotter-google-state=edge-state`,
    },
  });
  assert.equal(await appCallback.text(), "file");
  assert.equal(
    f.calls.find(({ url }) => url.endsWith(callback)).headers.get("cookie"),
    "oidc-state=app-state",
  );

  const login = await f.request("/login", { headers: { ...navigation, cookie } });
  assert.equal(await login.text(), "file");
  const logout = await f.request("/api/auth/logout", { method: "POST", headers: { cookie } });
  assert.deepEqual(logout.headers.getSetCookie(), [
    "app-session=; Max-Age=0",
    "__Host-snapotter-wake=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
  ]);
});

test("recognized cold navigation starts automatically and status/upload do not wake", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  f.advance(2100);
  f.healthy(false);
  const waiting = await f.request("/image/ocr", { headers: { ...navigation, cookie } });
  assert.match(await waiting.text(), /fetch\("\/_wake", \{ method: "POST"/);
  assert.equal((await f.request("/_wake/status", { headers: { cookie } })).status, 503);
  assert.equal(
    (await f.request("/api/upload", { method: "POST", headers: { cookie }, body: "upload" }))
      .status,
    503,
  );
  assert.equal(f.calls.filter(({ url }) => !url.endsWith("/api/v1/health")).length, 0);

  f.controller("stopping");
  const wake = () => f.request("/_wake", { method: "POST", headers: { ...fromBrowser, cookie } });
  const first = await Promise.all([wake(), wake(), wake()]);
  const states = (await Promise.all(first.map((item) => item.json()))).map(({ state }) => state);
  assert.ok(states.includes("stopping"));
  assert.ok(states.every((state) => state === "stopping" || state === "starting"));
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/wake")).length, 1);
  f.controller("starting");
  f.advance(10_001);
  assert.deepEqual(await (await wake()).json(), { state: "starting" });
  f.healthy(true);
  f.advance(3000);
  assert.deepEqual(await (await f.request("/_wake/status", { headers: { cookie } })).json(), {
    state: "ready",
  });
});

test("the wake endpoint accepts a zero-byte POST stream and rejects streams with data", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  f.advance(2100);
  f.healthy(false);

  const post = (body, headers = {}) =>
    f.request("/_wake", {
      method: "POST",
      headers: { ...fromBrowser, cookie, ...headers },
      body,
      duplex: "half",
    });
  const unexpected = new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array([1]));
    },
  });
  assert.equal((await post(unexpected)).status, 400);
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/wake")).length, 0);

  for (const headers of [{}, { "content-length": "0" }]) {
    const empty = new ReadableStream({
      start(stream) {
        stream.close();
      },
    });
    const response = await post(empty, headers);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { state: "starting" });
  }
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/wake")).length, 1);
});

test("fresh readiness gates a write and forwards its body only once as a stream", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  const request = new Request(`${env.PUBLIC_ORIGIN}/api/upload`, {
    method: "POST",
    body: "file-payload",
    headers: {
      authorization: "Bearer app-token",
      cookie: `app-token=keep; ${cookie}`,
      "x-snapotter-origin-token": "attacker",
      "x-snapotter-roster-token": "must-not-forward",
      "x-wake-internal": "attacker",
      "x-forwarded-host": "attacker",
    },
  });
  f.healthy(false);
  // Use a separate request for the interrupted upload.
  assert.equal(
    (await f.request("/api/upload", { method: "POST", headers: { cookie }, body: "file" })).status,
    503,
  );
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/api/upload")).length, 0);

  f.healthy(true);
  const worker = createWorker(
    async (url, init) => {
      if (url.endsWith("/api/v1/health")) return Response.json({ status: "healthy" });
      f.calls.push({ body: init.body, headers: new Headers(init.headers), url });
      return new Response("ok", {
        headers: {
          "set-cookie": "app-session=keep",
          "x-snapotter-origin-token": "hidden",
          "x-snapotter-roster-token": "hidden",
        },
      });
    },
    () => 1_800_000_000_000,
  );
  const response = await worker.fetch(request, f.environment);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("set-cookie"), "app-session=keep");
  assert.equal(response.headers.get("x-snapotter-origin-token"), null);
  assert.equal(response.headers.get("x-snapotter-roster-token"), null);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const uploads = f.calls.filter(({ url }) => url.endsWith("/api/upload"));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body, request.body);
  assert.equal(uploads[0].headers.get("cookie"), "app-token=keep");
  assert.equal(uploads[0].headers.get("authorization"), "Bearer app-token");
  assert.equal(uploads[0].headers.get("x-snapotter-origin-token"), env.ORIGIN_TOKEN);
  assert.equal(uploads[0].headers.get("x-wake-internal"), null);
  assert.equal(uploads[0].headers.get("x-snapotter-roster-token"), null);
  assert.equal(uploads[0].headers.get("x-forwarded-host"), "convert.example.test");
});

test("internal paths stay private and redirects use the public hostname", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  for (const path of [
    "/_internal",
    "//internal/stop",
    "/api/v1/%69nternal",
    "/api%2Finternal",
    "/_wake/extra",
  ]) {
    assert.equal((await f.request(path, { headers: { cookie } })).status, 404);
  }
  const redirect = await f.request("/redirect", { headers: { cookie } });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), `${env.PUBLIC_ORIGIN}/destination`);
});
