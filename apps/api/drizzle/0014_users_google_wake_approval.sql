ALTER TABLE "users" ADD COLUMN "google_wake_approved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "users" AS u
SET "google_wake_approved" = true
WHERE u."email" IS NOT NULL
  AND u."auth_provider" IN ('local', 'oidc')
  AND EXISTS (
    SELECT 1 FROM "audit_log" AS a
    WHERE a."action" = 'USER_CREATED'
      AND a."target_id" = u."id"
      AND a."details"->>'via' = 'google-approval-cli'
  );
