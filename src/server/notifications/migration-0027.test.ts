// @vitest-environment node
//
// Step 6.5.1 — Migration 0027 text invariants.
// Live integration tests against the local DB are not part of this project's pattern (see
// team-registration-migration.test.ts), so this asserts the migration text contains the
// notifications DDL, the target_user_id columns/indexes on both invitation tables, and the
// case-insensitive pending-non-expired backfill. The data-level backfill result is re-verified by
// the manual checklist at step 9.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(process.cwd(), "drizzle", "0027_graceful_zodiak.sql"), "utf-8");

describe("migration 0027 — notifications + invitation recipient resolution", () => {
  it("creates the notifications table with the required columns", () => {
    expect(text).toMatch(/CREATE TABLE "notifications"/);
    expect(text).toMatch(/"user_id" text NOT NULL/);
    expect(text).toMatch(/"type" text NOT NULL/);
    expect(text).toMatch(/"title" text NOT NULL/);
    expect(text).toMatch(/"body" text NOT NULL/);
    expect(text).toMatch(/"read_at" timestamp with time zone/);
  });

  it("adds the user_id FK with ON DELETE CASCADE", () => {
    expect(text).toMatch(
      /"notifications_user_id_users_id_fk"[\s\S]*REFERENCES "public"\."users"\("id"\) ON DELETE cascade/,
    );
  });

  it("creates the inbox-listing and unread composite/partial indexes", () => {
    expect(text).toMatch(
      /CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree \("user_id","created_at" DESC/,
    );
    expect(text).toMatch(
      /CREATE INDEX "notifications_user_id_unread_idx" ON "notifications" USING btree \("user_id"\) WHERE "notifications"\."read_at" IS NULL/,
    );
  });

  it("adds target_user_id (SET NULL) and an index to both invitation tables", () => {
    expect(text).toMatch(/ALTER TABLE "institution_invitations" ADD COLUMN "target_user_id" text/);
    expect(text).toMatch(/ALTER TABLE "team_invitations" ADD COLUMN "target_user_id" text/);
    expect(text).toMatch(
      /"institution_invitations_target_user_id_users_id_fk"[\s\S]*ON DELETE set null/,
    );
    expect(text).toMatch(/"team_invitations_target_user_id_users_id_fk"[\s\S]*ON DELETE set null/);
    expect(text).toMatch(/CREATE INDEX "institution_invitations_target_user_id_idx"/);
    expect(text).toMatch(/CREATE INDEX "team_invitations_target_user_id_idx"/);
  });

  it("backfills target_user_id for pending non-expired invitations via case-insensitive email match", () => {
    // institution_invitations backfill
    expect(text).toMatch(/UPDATE "institution_invitations"[\s\S]*SET "target_user_id" = u\."id"/);
    expect(text).toMatch(/lower\(ii\."invited_email"\) = lower\(u\."email"\)/);
    // team_invitations backfill
    expect(text).toMatch(/UPDATE "team_invitations"[\s\S]*SET "target_user_id" = u\."id"/);
    expect(text).toMatch(/lower\(ti\."invited_email"\) = lower\(u\."email"\)/);
    // both gate on pending status and non-expired
    expect(text).toMatch(/"status" = 'pending'/);
    expect(text).toMatch(/"expires_at" > now\(\)/);
  });
});
