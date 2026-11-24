import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { IdleAdmission } from "../../../apps/api/src/lib/idle-admission.js";
import {
  IdleControl,
  type IdleWorkSnapshot,
  listenForIdleControl,
} from "../../../apps/api/src/lib/idle-control.js";

const idleWindow = 15 * 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  const admission = new IdleAdmission();
  admission.lastActivity = 1;
  const snapshot = vi.fn<() => Promise<IdleWorkSnapshot>>().mockResolvedValue({
    pending: 0,
    lastJobCompletedAt: 0,
  });
  const pause = vi.fn(async () => {});
  const resume = vi.fn();
  const controller = new IdleControl(admission, { snapshot, pause, resume }, () => idleWindow + 1);
  return { admission, controller, snapshot, pause, resume };
}

describe("idle drain decisions", () => {
  it("requires a full idle window after a job completed", async () => {
    const { controller, snapshot } = fixture();
    snapshot.mockResolvedValue({ pending: 0, lastJobCompletedAt: 2 });
    expect((await controller.command("check")).body).toMatchObject({
      idle: false,
      reason: "recent-activity",
    });
  });

  it("does not drain when there is active work before or after worker quiescence", async () => {
    const { admission, controller, pause, resume, snapshot } = fixture();
    expect((await controller.command("check")).body.idle).toBe(true);
    snapshot.mockResolvedValueOnce({ pending: 1, lastJobCompletedAt: 0 });
    expect((await controller.command("drain")).body.reason).toBe("jobs");
    expect(pause).not.toHaveBeenCalled();
    expect(admission.closed).toBe(false);

    snapshot.mockResolvedValueOnce({ pending: 0, lastJobCompletedAt: 0 });
    snapshot.mockResolvedValueOnce({ pending: 1, lastJobCompletedAt: 0 });
    expect((await controller.command("drain")).body).toMatchObject({
      reason: "jobs",
      draining: false,
    });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalled();
    expect(admission.closed).toBe(false);
  });

  it("fails closed on unavailable job state", async () => {
    const { admission, controller, snapshot } = fixture();
    snapshot.mockRejectedValue(new Error("Database unavailable"));
    expect(await controller.command("drain")).toEqual({
      status: 503,
      body: { idle: false, draining: false, reason: "unavailable" },
    });
    expect(admission.closed).toBe(false);
  });

  it("does not enqueue new probes while a timed-out backend read is pending", async () => {
    const { controller, snapshot } = fixture();
    const delayed = deferred<IdleWorkSnapshot>();
    snapshot.mockReturnValueOnce(delayed.promise);
    vi.useFakeTimers();
    try {
      const first = controller.command("check");
      await vi.advanceTimersByTimeAsync(5000);
      expect((await first).status).toBe(503);
      expect((await controller.command("check")).status).toBe(503);
      expect(snapshot).toHaveBeenCalledTimes(1);
      delayed.resolve({ pending: 0, lastJobCompletedAt: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect((await controller.command("check")).body.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HTTP admission during idle drain", () => {
  it("blocks new requests before the snapshot and reopens them on cancel", async () => {
    const { admission, controller, snapshot } = fixture();
    const app = Fastify();
    admission.install(app);
    const runTool = vi.fn(async () => ({ ok: true }));
    app.post("/api/v1/tools/example", runTool);
    app.get("/api/v1/health", async () => ({ ok: true }));
    const checking = deferred<IdleWorkSnapshot>();
    snapshot.mockReturnValueOnce(checking.promise);
    try {
      const drain = controller.command("drain");
      const busy = await controller.command("cancel");
      expect(busy.status).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/v1/tools/example" })).statusCode).toBe(
        503,
      );
      const health = await app.inject("/api/v1/health");
      expect(health.statusCode).toBe(503);
      expect(health.headers["retry-after"]).toBe("15");
      expect(health.json()).toHaveProperty("code", "SERVICE_DRAINING");
      expect(runTool).not.toHaveBeenCalled();
      checking.resolve({ pending: 0, lastJobCompletedAt: 0 });
      expect((await drain).body).toMatchObject({ idle: true, draining: true });
      expect((await controller.command("cancel")).body.draining).toBe(false);
      expect((await app.inject({ method: "POST", url: "/api/v1/tools/example" })).statusCode).toBe(
        200,
      );
    } finally {
      checking.resolve({ pending: 0, lastJobCompletedAt: 0 });
      await app.close();
    }
  });

  it("tracks a download until its stream closes and leaves passive polls out of recent activity", async () => {
    const { admission, controller } = fixture();
    const app = Fastify();
    admission.install(app);
    const stream = new PassThrough();
    app.get("/api/v1/health", async () => ({ ok: true }));
    app.get("/api/auth/session", async () => ({ authenticated: true }));
    app.get("/assets/app.js", async () => "asset");
    app.get("/api/v1/download/:jobId/:filename", async (_request, reply) => reply.send(stream));
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await app.inject("/api/v1/health");
      await app.inject("/api/auth/session");
      await app.inject("/assets/app.js");
      expect(admission.lastActivity).toBe(1);
      const started = new Promise<void>((resolve, reject) => {
        get(`${base}/api/v1/download/example/out.zip`, (reply) => {
          reply.resume();
          resolve();
        }).on("error", reject);
      });
      stream.write("partial download");
      await started;
      expect((await controller.command("drain")).body.reason).toBe("requests");
      stream.end();
      await vi.waitFor(() => expect(admission.pending).toBe(0));
      expect((await controller.command("check")).body.reason).toBe("recent-activity");
    } finally {
      stream.destroy();
      await app.close();
    }
  });

  it("tracks an executing write after the client disconnects", async () => {
    const { admission, controller } = fixture();
    const app = Fastify();
    admission.install(app);
    const work = deferred<void>();
    const started = deferred<void>();
    app.post("/api/v1/upload", async () => {
      started.resolve();
      await work.promise;
      return { ok: true };
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const client = request(`${base}/api/v1/upload`, { method: "POST" });
      client.on("error", () => {});
      client.end();
      await started.promise;
      const disconnected = new Promise<void>((resolve) => client.once("close", resolve));
      client.destroy();
      await disconnected;
      expect((await controller.command("drain")).body.reason).toBe("requests");
      work.resolve();
      await vi.waitFor(() => expect(admission.pending).toBe(0));
      expect((await controller.command("check")).body.reason).toBe("recent-activity");
    } finally {
      work.resolve();
      await app.close();
    }
  });

  it("does not count an idle progress stream, and closes it on drain", async () => {
    const { admission, controller } = fixture();
    const app = Fastify();
    admission.install(app);
    app.get("/api/v1/jobs/:jobId/progress", async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write("data: ready\n\n");
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const ended = deferred<void>();
      await new Promise<void>((resolve, reject) => {
        get(`${base}/api/v1/jobs/example/progress`, (reply) => {
          reply.once("end", () => ended.resolve());
          reply.resume();
          resolve();
        }).on("error", reject);
      });
      expect(admission.pending).toBe(0);
      expect(admission.lastActivity).toBe(1);
      expect((await controller.command("drain")).body.draining).toBe(true);
      await ended.promise;
    } finally {
      admission.closeProgressStreams();
      await app.close();
    }
  });
});

it("binds the opt-in management listener on loopback and requires the token file secret", async () => {
  const { controller } = fixture();
  const dir = await mkdtemp(join(tmpdir(), "snapotter-idle-"));
  const path = join(dir, "token");
  const token = "test-token-with-adequate-length-for-checks";
  await writeFile(path, `${token}\n`);
  const server = await listenForIdleControl(path, controller, 0);
  try {
    expect(server.server.address()).toMatchObject({ address: "127.0.0.1" });
    const endpoint = "/api/v1/internal/idle/check";
    expect((await server.inject({ method: "POST", url: endpoint })).statusCode).toBe(401);
    const reply = await server.inject({
      method: "POST",
      url: endpoint,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ idle: true, draining: false, reason: "idle" });
  } finally {
    await server.close();
    await rm(dir, { recursive: true });
  }
});
