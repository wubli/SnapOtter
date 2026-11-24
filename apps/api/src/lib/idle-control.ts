import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import type { IdleAdmission } from "./idle-admission.js";

const idleMs = 15 * 60_000;
const checkTimeoutMs = 5_000;
const endpoint = "/api/v1/internal/idle";

export interface IdleWorkSnapshot {
  pending: number;
  lastJobCompletedAt: number;
}

interface IdleSources {
  snapshot: () => Promise<IdleWorkSnapshot>;
  pause: () => Promise<void>;
  resume: () => void;
}

export class IdleControl {
  private operation = false;
  private probing = false;
  private drained = false;

  constructor(
    private admission: IdleAdmission,
    private sources: IdleSources,
    private now: () => number = Date.now,
  ) {}

  async command(command: "check" | "drain" | "cancel") {
    if (this.operation) return this.result(false, "checking", 409);
    if (command === "cancel") {
      this.release();
      return this.result(false, "cancelled");
    }
    if (this.drained) return this.result(true, "draining");
    this.operation = true;
    if (command === "drain") this.admission.closed = true;

    try {
      const before = await this.check();
      if (before || command === "check") return this.result(!before, before ?? "idle");
      await withCheckTimeout(this.sources.pause());
      const after = await this.check();
      if (after) return this.result(false, after);
      this.drained = true;
      this.admission.closeProgressStreams();
      return this.result(true, "draining");
    } catch {
      return this.result(false, "unavailable", 503);
    } finally {
      this.operation = false;
      if (command === "drain" && !this.drained) this.release();
    }
  }

  private async check(): Promise<string | null> {
    if (this.admission.pending > 0) return "requests";
    if (this.probing) throw new Error("Idle backend probe is still pending");
    this.probing = true;
    const snapshot = await withCheckTimeout(this.readSnapshot());
    if (this.admission.pending > 0) return "requests";
    if (snapshot.pending > 0) return "jobs";
    const lastActivity = Math.max(this.admission.lastActivity, snapshot.lastJobCompletedAt);
    if (this.now() - lastActivity < idleMs) return "recent-activity";
    return null;
  }

  private async readSnapshot() {
    try {
      return await this.sources.snapshot();
    } finally {
      // BullMQ keeps Redis commands queued during a disconnect. Refusing
      // overlapping probes avoids growing that backlog or reusing stale reads.
      this.probing = false;
    }
  }

  private release() {
    this.sources.resume();
    this.drained = false;
    this.admission.closed = false;
  }

  private result(idle: boolean, reason: string, status = 200) {
    return { status, body: { idle, draining: this.drained, reason } };
  }
}

async function withCheckTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Idle check timed out")), checkTimeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export async function listenForIdleControl(
  tokenFile: string,
  controller: IdleControl,
  port = 13491,
) {
  const secret = (await readFile(tokenFile, "utf8")).trim();
  if (!/^[!-~]{32,256}$/.test(secret)) throw new Error("Invalid idle control token file");
  const expected = digest(`Bearer ${secret}`);
  const app = Fastify({ bodyLimit: 1024, requestTimeout: 20_000 });
  for (const command of ["check", "drain", "cancel"] as const) {
    app.post(`${endpoint}/${command}`, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ""))) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const result = await controller.command(command);
      return reply.code(result.status).send(result.body);
    });
  }
  await app.listen({ host: "127.0.0.1", port });
  return app;
}
