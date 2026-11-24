import { sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getQueue } from "../jobs/queues.js";
import { SYSTEM_JOBS } from "../jobs/system-jobs.js";
import { POOLS } from "../jobs/types.js";
import { getActiveAndQueuedInstalls } from "./feature-install-queue.js";
import type { IdleWorkSnapshot } from "./idle-control.js";

const scheduledNames = new Set<string>(
  Object.values(SYSTEM_JOBS).filter((name) => name !== SYSTEM_JOBS.gdprExport),
);

const unfinishedStates = [
  "active",
  "waiting",
  "paused",
  "prioritized",
  "waiting-children",
  "delayed",
] as const;

export async function snapshotIdleWork(): Promise<IdleWorkSnapshot> {
  const [queueResult, dbResult] = await Promise.allSettled([
    Promise.allSettled(
      POOLS.map(async (pool) => {
        const queue = getQueue(pool);
        const counts = await queue.getJobCounts(...unfinishedStates);
        let pending = 0;
        for (const state of unfinishedStates) {
          const count = counts[state];
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error("Invalid Redis idle work snapshot");
          }
          if (state !== "delayed" || pool !== "system") pending += count;
        }
        if (pool === "system" && counts.delayed > 0) {
          const delayed = await queue.getDelayed();
          const scheduled = delayed.filter(
            (job) =>
              job.repeatJobKey &&
              job.id?.startsWith("repeat:") &&
              job.attemptsMade === 0 &&
              scheduledNames.has(job.name) &&
              job.timestamp + job.delay > Date.now(),
          ).length;
          // A scheduled job may become runnable between the queries. Count a
          // missing delayed job conservatively in the initial check.
          pending += Math.max(counts.delayed, delayed.length) - scheduled;
        }
        return pending;
      }),
    ),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${schema.jobs.status} in ('queued', 'processing'))::int`,
        lastCompleted: sql<number>`coalesce(extract(epoch from max(${schema.jobs.completedAt})) * 1000, 0)::float8`,
      })
      .from(schema.jobs),
  ]);
  if (queueResult.status === "rejected") throw queueResult.reason;
  if (dbResult.status === "rejected") throw dbResult.reason;

  let queueCount = 0;
  for (const result of queueResult.value) {
    if (result.status === "rejected") throw result.reason;
    queueCount += result.value;
  }
  const [row] = dbResult.value;
  if (
    !row ||
    !Number.isSafeInteger(row.pending) ||
    row.pending < 0 ||
    !Number.isFinite(row.lastCompleted)
  ) {
    throw new Error("Invalid idle work snapshot");
  }
  return {
    pending: row.pending + queueCount + getActiveAndQueuedInstalls().length,
    lastJobCompletedAt: row.lastCompleted,
  };
}
