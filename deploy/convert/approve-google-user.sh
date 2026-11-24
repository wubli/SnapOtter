#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 && ( $# != 3 || ${3:-} != --workspace ) ]]; then
  echo "Usage: $0 USERNAME PRIMARY_GOOGLE_EMAIL [--workspace]" >&2
  exit 2
fi

docker compose exec -T --workdir /app/apps/api snapotter   node --import tsx --input-type=module - "$@" <<'NODE'
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const [username, email, workspace] = process.argv.slice(2);
const isGmail = email.endsWith("@gmail.com");
if (
  !z.string().email().max(254).safeParse(email).success ||
  email !== email.toLowerCase() ||
  (!isGmail && workspace !== "--workspace")
) {
  console.error("Use the lowercase primary Gmail address, or explicitly approve a managed Google Workspace address with --workspace.");
  process.exit(2);
}

class ApprovalError extends Error {}
let closeDb;
try {
  // Compose exec does not inherit values that the entrypoint read from secret files.
  if (process.env.OIDC_CLIENT_SECRET_FILE) {
    process.env.OIDC_CLIENT_SECRET = (
      await readFile(process.env.OIDC_CLIENT_SECRET_FILE, "utf8")
    ).trim();
  }
  const { db, schema, closeDb: close } = await import("./src/db/index.ts");
  closeDb = close;
  const { validateUsername } = await import("./src/plugins/auth.ts");
  const { userLimitReached } = await import("./src/lib/user-limit.ts");
  const { auditLog } = await import("./src/lib/audit.ts");
  const { logger } = await import("./src/lib/logger.ts");

  const usernameError = validateUsername(username);
  if (usernameError) throw new ApprovalError(usernameError);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    // Take the shared MAX_USERS advisory lock first, in the same order as
    // native provisioning. The table lock also serializes case-insensitive
    // email collision checks when MAX_USERS is unlimited.
    const atLimit = await userLimitReached(tx);
    await tx.execute(sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);

    const [team] = await tx.select({ id: schema.teams.id }).from(schema.teams)
      .where(eq(schema.teams.name, "Default"));
    if (!team) throw new ApprovalError("The default team is missing. Start SnapOtter before approving users.");

    const matches = await tx.select().from(schema.users).where(sql`
      lower(${schema.users.username}) = lower(${username})
      OR lower(${schema.users.email}) = ${email}
    `).limit(2);
    const [existing] = matches;
    if (existing) {
      const enrollmentState =
        (existing.authProvider === "local" && existing.externalId === null) ||
        (existing.authProvider === "oidc" && !!existing.externalId);
      if (
        matches.length !== 1 ||
        existing.username !== username ||
        existing.email !== email ||
        !existing.googleWakeApproved ||
        existing.team !== team.id ||
        existing.passwordHash !== null ||
        existing.scimExternalId !== null ||
        existing.mustChangePassword ||
        !enrollmentState
      ) {
        throw new ApprovalError("A username or email collides with an existing account. No rows changed.");
      }
      return { id: existing.id, created: false };
    }

    if (atLimit) throw new ApprovalError("The instance user limit is reached. No rows changed.");
    const id = randomUUID();
    await tx.insert(schema.users).values({
      id,
      username,
      email,
      role: "user",
      team: team.id,
      authProvider: "local",
      passwordHash: null,
      googleWakeApproved: true,
      mustChangePassword: false,
    });
    return { id, created: true };
  });

  if (result.created) {
    await auditLog(logger, "USER_CREATED", {
      username: "operator",
      newUserId: result.id,
      newUsername: username,
      role: "user",
      via: "google-approval-cli",
    });
  }
  console.log(result.created ? "Approved a new ordinary Google user." : "This Google user is already approved.");
} catch (error) {
  console.error(error instanceof ApprovalError ? error.message : "Google user approval failed. Check the deployment configuration or database.");
  process.exitCode = 1;
} finally {
  await closeDb?.();
}
NODE
