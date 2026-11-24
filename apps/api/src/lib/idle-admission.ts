import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const progressRoute = "/api/v1/jobs/:jobId/progress";
const passiveReads = new Set([
  "/api/auth/session",
  "/api/v1/health",
  "/api/v1/readyz",
  "/api/v1/admin/health",
  "/api/v1/jobs/:jobId",
  progressRoute,
  "/api/v1/features",
  "/api/v1/settings",
  "/api/v1/settings/:key",
  "/api/v1/preferences",
]);

type RequestActivity = "active" | "passive" | "progress" | "static";

function classify(request: FastifyRequest): RequestActivity {
  const path = request.url.split("?", 1)[0];
  const route = request.routeOptions.url ?? path;
  if (request.method === "OPTIONS" || path.startsWith("/ingest")) return "passive";
  if (request.method === "GET" || request.method === "HEAD") {
    if (route === progressRoute) return "progress";
    if (passiveReads.has(route) || path.startsWith("/api/v1/config/")) return "passive";
    if (path.startsWith("/api/")) return "active";
    if (
      request.method === "GET" &&
      (request.headers["sec-fetch-mode"] === "navigate" ||
        request.headers.accept?.includes("text/html"))
    ) {
      return "active";
    }
  } else if (path.startsWith("/api/")) {
    return "active";
  }
  return "static";
}

interface RequestState {
  stream: ServerResponse;
  activity: RequestActivity;
  handling: boolean;
  attempted: boolean;
  wireDone: boolean;
  released: boolean;
}

export class IdleAdmission {
  closed = false;
  lastActivity = Date.now();
  private inflight = 0;
  private progressStreams = new Set<ServerResponse>();

  get pending(): number {
    return this.inflight;
  }

  beginWork(): () => void {
    this.inflight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight--;
    };
  }

  closeProgressStreams() {
    for (const response of this.progressStreams) response.end();
  }

  install(app: FastifyInstance) {
    const requests = new WeakMap<FastifyRequest, RequestState>();

    const refuse = (reply: FastifyReply) =>
      reply.header("Retry-After", "15").code(503).send({
        error: "Service is draining",
        code: "SERVICE_DRAINING",
      });

    app.addHook("onRequest", async (request, reply) => {
      const activity = classify(request);
      if (this.closed) return refuse(reply);
      if (activity === "static") return;

      const state = {
        stream: reply.raw,
        activity,
        handling: false,
        attempted: false,
        wireDone: false,
        released: false,
      };
      requests.set(request, state);
      this.inflight++;
      if (activity === "progress") this.progressStreams.add(reply.raw);
      const wireDone = () => {
        state.wireDone = true;
        this.progressStreams.delete(reply.raw);
        this.release(state);
      };
      reply.raw.once("finish", wireDone);
      reply.raw.once("close", wireDone);
    });

    app.addHook("onRoute", (options) => {
      const handler = options.handler;
      const admission = this;
      options.handler = async function (request, reply) {
        const state = requests.get(request);
        // The peer may disconnect during validation, before this handler starts.
        if (state?.released && state.wireDone) return;
        if (admission.closed && !state) return refuse(reply);
        if (!state) return handler.call(this, request, reply);
        state.handling = true;
        state.attempted = true;
        try {
          return await handler.call(this, request, reply);
        } finally {
          state.handling = false;
          admission.release(state);
        }
      };
    });
  }

  private release(state: RequestState) {
    if (state.released || state.handling || (!state.wireDone && state.activity !== "progress")) {
      return;
    }
    state.released = true;
    this.inflight--;
    // A disconnected request can still complete a write in its handler.
    // Keep the service warm for successful work or an interrupted transfer.
    if (
      state.activity === "active" &&
      (state.stream.headersSent
        ? state.stream.statusCode < 400
        : state.attempted && state.stream.destroyed && state.stream.statusCode === 200)
    ) {
      this.lastActivity = Date.now();
    }
  }
}
