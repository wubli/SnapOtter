import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../apps/api/src/config.js";
import { db, schema } from "../../../apps/api/src/db/index.js";
import { resolveExternalUser } from "../../../apps/api/src/lib/external-auth-resolver.js";
import { verifiedGoogleWakeEmail } from "../../../apps/api/src/lib/google-wake-users.js";
import { hashSessionToken } from "../../../apps/api/src/lib/session-token.js";
import { buildTestApp, loginAsAdmin, type TestApp } from "../test-server.js";

const saved = {
  GOOGLE_WAKE_USER_MANAGEMENT: env.GOOGLE_WAKE_USER_MANAGEMENT,
  OIDC_ENABLED: env.OIDC_ENABLED,
  OIDC_ISSUER_URL: env.OIDC_ISSUER_URL,
  OIDC_AUTO_LINK_USERS: env.OIDC_AUTO_LINK_USERS,
  OIDC_AUTO_CREATE_USERS: env.OIDC_AUTO_CREATE_USERS,
};

let server: TestApp;
let adminToken: string;

beforeAll(async () => {
  server = await buildTestApp();
  adminToken = await loginAsAdmin(server.app);
  Object.assign(env, {
    GOOGLE_WAKE_USER_MANAGEMENT: true,
    OIDC_ENABLED: true,
    OIDC_ISSUER_URL: "https://accounts.google.com",
    OIDC_AUTO_LINK_USERS: true,
    OIDC_AUTO_CREATE_USERS: false,
  });
});

afterAll(async () => {
  Object.assign(env, saved);
  await server?.cleanup();
});

function approve(username: string, googleEmail: string, role?: string, token = adminToken) {
  return server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { authorization: `Bearer ${token}` },
    payload: { username, googleEmail, role },
  });
}

function resolve(email: string, sub: string) {
  return resolveExternalUser({
    provider: "oidc",
    externalId: sub,
    email,
    emailVerified: true,
    googleWakeManaged: true,
    username: "unused",
    autoCreate: false,
    autoLink: true,
    defaultRole: "user",
    logger: server.app.log,
    ip: "127.0.0.1",
    requestId: "test-google-wake",
  });
}

function setDisabled(id: string, disabled: boolean, token = adminToken) {
  return server.app.inject({
    method: "PUT",
    url: `/api/auth/users/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { disabled },
  });
}

describe("admin-managed Google wake accounts", () => {
  it("requires full admin authority and creates an ordinary passwordless approval", async () => {
    const unprivileged = await approve("g-no-admin", "noadmin@gmail.com", undefined, "bogus");
    expect(unprivileged.statusCode).toBe(401);
    const privileged = await approve("g-only-user", "onlyuser@gmail.com", "admin");
    expect(privileged.statusCode).toBe(400);
    const added = await approve("g-member", "  Member@GMAIL.COM  ");
    expect(added.statusCode).toBe(201);
    const { id } = added.json();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(user).toMatchObject({
      email: "member@gmail.com",
      googleWakeApproved: true,
      passwordHash: null,
      mustChangePassword: false,
      role: "user",
    });
    expect((await approve("g-duplicate", "MEMBER@gmail.com")).statusCode).toBe(409);
    const list = await server.app.inject({
      url: "/api/auth/users",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json()).toMatchObject({
      googleWakeManaged: true,
      users: expect.arrayContaining([
        expect.objectContaining({ id, googleWakeApproved: true, isDisabled: false }),
      ]),
    });
  });

  it("links an approved identity once and excludes disabled, deleted and unmarked accounts", async () => {
    const email = "native-link@gmail.com";
    const created = await approve("g-native-link", email);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const unrelated = randomUUID();
    await db
      .insert(schema.users)
      .values({ id: unrelated, username: "not-approved", email: "other@gmail.com" });

    expect((await resolve("other@gmail.com", "unknown-subject")).action).toBe("denied");
    expect((await resolve(email, "first-subject")).action).toBe("linked");
    expect((await resolve(email, "first-subject")).action).toBe("matched");
    expect((await resolve(email, "other-subject")).action).toBe("denied");
    expect((await resolve("changed@gmail.com", "first-subject")).action).toBe("denied");

    const sessionToken = randomUUID();
    const sessionId = hashSessionToken(sessionToken);
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId: id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await setDisabled(id, true)).statusCode).toBe(200);
    expect(
      await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)),
    ).toEqual([]);
    expect((await resolve(email, "first-subject")).deniedReason).toBe("user_disabled");
    expect((await setDisabled(id, false)).statusCode).toBe(200);
    expect((await resolve(email, "first-subject")).action).toBe("matched");
    expect((await setDisabled(unrelated, true)).statusCode).toBe(400);
    const deletion = await server.app.inject({
      method: "DELETE",
      url: `/api/auth/users/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deletion.statusCode).toBe(200);
    expect((await resolve(email, "first-subject")).action).toBe("denied");
  });

  it("preserves an approved Google administrator's role and protects self-disable", async () => {
    const email = "approved-admin@gmail.com";
    const created = await approve("g-approved-admin", email);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, id));
    expect((await resolve(email, "approved-admin-subject")).user?.role).toBe("admin");
    expect((await setDisabled(id, true)).statusCode).toBe(200);
    const [disabled] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(disabled.role).toBe("disabled:admin");
    expect((await setDisabled(id, false)).statusCode).toBe(200);

    const token = randomUUID();
    await db.insert(schema.sessions).values({
      id: hashSessionToken(token),
      userId: id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await setDisabled(id, true, token)).json()).toMatchObject({ code: "SELF_DEMOTE" });
    expect((await resolve(email, "approved-admin-subject")).user?.role).toBe("admin");
  });

  it("accepts only authoritative Google attestations by Gmail or Workspace", () => {
    expect(verifiedGoogleWakeEmail({ email: "Gmail@GMAIL.COM", email_verified: true })).toBe(
      "gmail@gmail.com",
    );
    expect(
      verifiedGoogleWakeEmail({ email: "org@example.com", email_verified: true }),
    ).toBeUndefined();
    expect(
      verifiedGoogleWakeEmail({
        email: "org@example.com",
        email_verified: true,
        hd: "example.com",
      }),
    ).toBe("org@example.com");
  });
});
