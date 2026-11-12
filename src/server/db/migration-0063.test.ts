// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0063_site_contact_and_team_reminder.sql");

describe("migration 0063", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("creates the organiser contact kind with its three values in order", () => {
    expect(sql).toContain(
      "CREATE TYPE \"public\".\"organizer_contact_kind\" AS ENUM('whatsapp', 'phone', 'email');",
    );
  });

  it("adds the three columns, each nullable", () => {
    expect(sql).toContain(
      'ALTER TABLE "competitions" ADD COLUMN "organizer_contact_kind" "organizer_contact_kind";',
    );
    expect(sql).toContain('ALTER TABLE "competitions" ADD COLUMN "organizer_contact_value" text;');
    expect(sql).toContain(
      'ALTER TABLE "teams" ADD COLUMN "join_reminder_close_at" timestamp with time zone;',
    );
    expect(sql).not.toContain("NOT NULL");
  });

  it("pairs the contact kind and value in one check", () => {
    expect(sql).toContain(
      'ALTER TABLE "competitions" ADD CONSTRAINT "competitions_organizer_contact_pair_chk" CHECK (("competitions"."organizer_contact_kind" IS NULL) = ("competitions"."organizer_contact_value" IS NULL));',
    );
  });

  it("changes nothing that already exists", () => {
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("ALTER COLUMN");
    expect(sql).not.toContain("UPDATE ");
    expect(sql).not.toContain("RENAME");
  });
});
