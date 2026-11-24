import { z } from "zod";
import { env } from "../config.js";

export const googleWakeEmailSchema = z.string().trim().toLowerCase().email().max(254);

export function isGoogleWakeManagementEnabled(): boolean {
  return (
    env.GOOGLE_WAKE_USER_MANAGEMENT &&
    env.OIDC_ENABLED &&
    env.OIDC_ISSUER_URL === "https://accounts.google.com" &&
    env.OIDC_AUTO_LINK_USERS &&
    !env.OIDC_AUTO_CREATE_USERS
  );
}

export function verifiedGoogleWakeEmail(claims: Record<string, unknown>): string | undefined {
  const parsed = googleWakeEmailSchema.safeParse(claims.email);
  if (claims.email_verified !== true || !parsed.success) return;
  if (
    parsed.data.endsWith("@gmail.com") ||
    (typeof claims.hd === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(claims.hd))
  ) {
    return parsed.data;
  }
}
