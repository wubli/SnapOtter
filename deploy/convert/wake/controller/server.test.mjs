import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createWakeServer } from "./server.mjs";

const instance =
  "https://compute.googleapis.com/compute/v1/projects/convertxx/zones/europe-central2-b/instances/snapotter";
const token = "test-controller-token";

async function listen(t, upstream, now) {
  const server = createWakeServer({
    token,
    now,
    fetchImpl: async (url, { headers, method, redirect, signal }) => {
      assert.equal(redirect, "error");
      assert.ok(signal instanceof AbortSignal);
      if (url === "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") {
        assert.deepEqual(headers, { "Metadata-Flavor": "Google" });
        assert.equal(method, undefined);
        return Response.json({ access_token: "test-compute-token" });
      }
      assert.deepEqual(headers, { Authorization: "Bearer test-compute-token" });
      if (method === "POST") {
        assert.match(url, new RegExp(`^${instance}/start\\?requestId=[0-9a-f-]{36}$`));
        return upstream("start", new URL(url).searchParams.get("requestId"));
      }
      assert.equal(url, `${instance}?fields=status`);
      return upstream("get");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path = "/wake", options = {}) => fetch(origin + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    ...options,
  });
}

test("requires the wake path, POST, and the shared token", async (t) => {
  let calls = 0;
  const request = await listen(t, () => { calls++; });
  assert.equal((await request("/wake?target=other")).status, 404);
  const method = await request("/wake", { method: "GET" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "POST");
  for (const headers of [{}, { Authorization: "Bearer incorrect" }]) {
    const response = await request("/wake", { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
  }
  assert.equal(calls, 0);
  assert.throws(() => createWakeServer(), /WAKE_CONTROLLER_TOKEN/);
});

test("reports VM transitions and starts only a terminated VM", async (t) => {
  let status = "RUNNING";
  let starts = 0;
  const request = await listen(t, (method) => {
    if (method === "get") return Response.json({ status });
    starts++;
    return Response.json({ status: "PENDING" });
  }, () => 0);

  for (const [vmStatus, expected, code] of [
    ["RUNNING", "running", 200],
    ["PROVISIONING", "starting", 202],
    ["STAGING", "starting", 202],
    ["STOPPING", "stopping", 202],
    ["TERMINATED", "starting", 202],
    ["TERMINATED", "starting", 202],
  ]) {
    status = vmStatus;
    const response = await request();
    assert.equal(response.status, code);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Retry-After"), code === 202 ? "3" : null);
    assert.deepEqual(await response.json(), { state: expected });
    assert.equal(starts, status === "TERMINATED" ? 1 : 0);
  }
});

test("coalesces concurrent wake requests into one start", async (t) => {
  let starts = 0;
  const request = await listen(t, async (method) => {
    if (method === "get") return Response.json({ status: "TERMINATED" });
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return Response.json({ status: "PENDING" });
  });
  const responses = await Promise.all(Array.from({ length: 12 }, () => request()));
  assert.equal(starts, 1);
  for (const response of responses) {
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { state: "starting" });
  }
});

test("reconciles a conflict with a concurrent start", async (t) => {
  let status = "TERMINATED";
  const request = await listen(t, (method) => {
    if (method === "get") return Response.json({ status });
    status = "STAGING";
    return new Response("upstream details", { status: 409 });
  });
  const response = await request();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { state: "starting" });
});

test("retries ambiguous starts with the same request ID and expires stale acceptance", async (t) => {
  const requestIds = [];
  let now = 0;
  const request = await listen(t, (method, id) => {
    if (method === "get") return Response.json({ status: "TERMINATED" });
    requestIds.push(id);
    if (requestIds.length === 1) return new Response("confidential upstream error", { status: 503 });
    return Response.json({ status: "PENDING" });
  }, () => now);
  const failure = await request();
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("Retry-After"), "3");
  assert.deepEqual(await failure.json(), { error: "temporarily_unavailable" });

  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 202);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);

  now = 16_000;
  assert.equal((await request()).status, 202);
  assert.equal(requestIds.length, 3);
  assert.notEqual(requestIds[1], requestIds[2]);
});
