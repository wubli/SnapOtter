import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorker } from "./public/_worker.js";

const env = {
  PUBLIC_ORIGIN: "https://convert.example.test",
  ORIGIN_URL: "https://origin.example.test",
  WAKE_CONTROLLER_URL: "https://controller.example.test",
  WAKE_CONTROLLER_TOKEN: "controller-fixture-token",
  ORIGIN_TOKEN: "origin-fixture-token",
  WAKE_COOKIE_SECRET: "fixture-signer-secret-thirty-two-bytes",
  WAKE_PASSPHRASE: "fixture-passphrase-twenty-four-bytes",
};

function scenario() {
  let healthy = false;
  let availableAt = 1_800_000_000_000;
  let state = "starting";
  const calls = [];
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
  );

  function request(path, init) {
    return worker.fetch(new Request(env.PUBLIC_ORIGIN + path, init), env);
  }

  function unlock(passphrase = env.WAKE_PASSPHRASE, origin = env.PUBLIC_ORIGIN) {
    return request("/_wake", {
      method: "POST",
      headers: { origin },
      body: new URLSearchParams({ passphrase }),
    });
  }

  return {
    calls,
    request,
    unlock,
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
  const response = await fixture.unlock();
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^__Host-snapotter-wake=v1\.\d+\.[a-zA-Z0-9_-]{43};/);
  assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  return cookie.split(";")[0];
}

test("only an authorized browser action can contact the controller", async () => {
  const f = scenario();
  const gate = await f.request("/", { headers: navigation });
  assert.equal(gate.headers.get("referrer-policy"), "same-origin");
  assert.match(await gate.text(), /Team passphrase/);
  assert.equal((await f.request("/api/v1/health")).status, 401);
  assert.equal((await f.request("/_wake/status")).status, 401);
  assert.equal((await f.unlock("incorrect")).status, 401);
  assert.equal((await f.unlock(env.WAKE_PASSPHRASE, "https://another.example.test")).status, 403);
  assert.equal((await f.unlock("x".repeat(2600))).status, 401);
  assert.deepEqual(f.calls, []);

  await cookieFor(f);
  const wakes = f.calls.filter(({ url }) => url.endsWith("/wake"));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].method, "POST");
  assert.equal(wakes[0].headers.get("authorization"), `Bearer ${env.WAKE_CONTROLLER_TOKEN}`);
  assert.equal(wakes[0].headers.get("cookie"), null);
});

test("signed cookie expires and tampering cannot reach origin", async () => {
  const f = scenario();
  f.healthy(true);
  const cookie = await cookieFor(f);
  const tampered = cookie.replace(/v1\.\d+\./, "v1.1800000123.");
  assert.equal((await f.request("/", { headers: { cookie: tampered } })).status, 401);
  f.advance(7 * 24 * 60 * 60_000);
  assert.equal((await f.request("/", { headers: { cookie } })).status, 401);
  assert.equal(f.calls.length, 1);
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
        headers: { "set-cookie": "app-session=keep", "x-snapotter-origin-token": "hidden" },
      });
    },
    () => 1_800_000_000_000,
  );
  const response = await worker.fetch(request, env);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("set-cookie"), "app-session=keep");
  assert.equal(response.headers.get("x-snapotter-origin-token"), null);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const uploads = f.calls.filter(({ url }) => url.endsWith("/api/upload"));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body, request.body);
  assert.equal(uploads[0].headers.get("cookie"), "app-token=keep");
  assert.equal(uploads[0].headers.get("authorization"), "Bearer app-token");
  assert.equal(uploads[0].headers.get("x-snapotter-origin-token"), env.ORIGIN_TOKEN);
  assert.equal(uploads[0].headers.get("x-wake-internal"), null);
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
