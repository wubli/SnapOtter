import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { jobs } from "../../db/schema.js";
import { isDeploymentToolDisabled } from "../../lib/ai-tool-policy.js";

const DEFAULT_POPULAR = [
  "resize",
  "crop",
  "compress",
  "convert",
  "remove-background",
  "upscale",
  "merge-pdf",
  "watermark-text",
  "compress-video",
  "trim-video",
  "convert-audio",
  "compress-pdf",
];

const availableDefaults = DEFAULT_POPULAR.filter((id) => !isDeploymentToolDisabled(id));

export async function registerPopularTools(app: FastifyInstance) {
  app.get("/api/v1/tools/popular", async () => {
    try {
      const rows = await db
        .select({
          toolId: jobs.toolId,
          count: sql<number>`count(*)`.as("count"),
        })
        .from(jobs)
        .groupBy(jobs.toolId)
        .orderBy(sql`count(*) desc`)
        .limit(12);

      if (rows.length < 4) {
        return { tools: availableDefaults };
      }
      return {
        tools: rows
          .map((r) => r.toolId)
          .filter((id) => id === null || !isDeploymentToolDisabled(id)),
      };
    } catch {
      return { tools: availableDefaults };
    }
  });
}
