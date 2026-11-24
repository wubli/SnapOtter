import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const origin = "http://127.0.0.1:1349";
const idleUrl = "http://127.0.0.1:13491/api/v1/internal/idle/check";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQaHhAEmIY1TCqYfhqAABldYAQqespPwAAAABJRU5ErkJggg==",
  "base64",
);

async function checkIdle(token) {
  const response = await fetch(idleUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6_000),
  });
  assert.equal(response.status, 200, "Idle observer did not return HTTP 200");
  return response.json();
}

async function parseResult(status, body, headers) {
  assert.ok(status === 200 || status === 202, `Conversion returned HTTP ${status}`);
  let result = JSON.parse(body);
  if (status === 200) return result;

  const jobUrl = `${origin}/api/v1/jobs/${encodeURIComponent(result.jobId)}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(jobUrl, { headers, signal: AbortSignal.timeout(6_000) });
    assert.equal(response.status, 200, "Job check did not return HTTP 200");
    const job = await response.json();
    if (job.status === "completed") return job.result;
    assert.ok(!["failed", "cancelled", "canceled"].includes(job.status), `Conversion ${job.status}`);
    await delay(250);
  }
  assert.fail("Conversion did not finish within 30 seconds");
}

async function main() {
  const username = process.argv[1] ?? "admin";
  process.stdin.setEncoding("utf8");
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  password = password.replace(/[\r\n]+$/, "");
  assert.ok(password.length > 0, "Supply the current SnapOtter password on standard input");
  const token = (await readFile("/run/secrets/idle_token", "utf8")).trim();

  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200, "Login failed");
  const session = await login.json();
  assert.ok(!session.user.mustChangePassword, "Rotate the bootstrap password before the smoke test");
  assert.ok(session.token, "Login did not return a session token");
  const headers = { Authorization: `Bearer ${session.token}` };

  const baseline = await checkIdle(token);
  assert.equal(baseline.draining, false, "Retry after the production drain finishes");
  assert.notEqual(baseline.reason, "requests", "Retry when the origin has no other active requests");

  const boundary = randomUUID();
  const opening = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="settings"\r\n\r\n` +
    `{"format":"jpg"}\r\n--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="idle-smoke.png"\r\n' +
    "Content-Type: image/png\r\n\r\n",
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const upload = request(`${origin}/api/v1/tools/image/convert`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": opening.length + png.length + closing.length,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const uploaded = new Promise((resolve, reject) => {
    upload.on("error", reject);
    upload.once("response", async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve([response.statusCode, Buffer.concat(chunks)]);
      } catch (error) {
        reject(error);
      }
    });
  });

  // Hold back the final image byte and multipart terminator until the guard
  // sees the HTTP upload as active.
  upload.write(opening);
  upload.write(png.subarray(0, -1));
  const observed = async () => {
    const deadline = Date.now() + 5_000;
    do {
      const state = await checkIdle(token);
      if (!state.idle && !state.draining && state.reason === "requests") {
        console.log("Idle guard reported an active upload.");
        return;
      }
      await delay(200);
    } while (Date.now() < deadline);
    assert.fail("Idle guard did not report the held conversion upload");
  };

  let response;
  try {
    [, response] = await Promise.all([
      observed().finally(() => upload.end(Buffer.concat([png.subarray(-1), closing]))),
      uploaded,
    ]);
  } finally {
    upload.destroy();
  }
  const result = await parseResult(...response, headers);
  const download = new URL(result.downloadUrl, origin);
  assert.equal(download.origin, origin, "Conversion returned an unexpected download origin");
  const output = await fetch(download, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(output.status, 200, "Could not download conversion result");
  assert.equal(output.headers.get("Content-Type"), "image/jpeg");
  const jpeg = Buffer.from(await output.arrayBuffer());
  assert.equal(jpeg.length, result.processedSize);
  assert.ok(jpeg.subarray(0, 3).equals(Buffer.from([255, 216, 255])), "Invalid JPEG header");
  assert.ok(jpeg.subarray(-2).equals(Buffer.from([255, 217])), "Invalid JPEG end marker");
  console.log("Released the upload and verified the downloaded JPEG.");
}

main().catch((error) => {
  console.error(`Busy-guard verification failed: ${error.message}`);
  process.exitCode = 1;
});
