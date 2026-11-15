// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0065_team_invitations_expire_at_close.sql");

describe("migration 0065", () => {
  it("only gives the open team invites the registration close as their expiry", () => {
    const sql = readFileSync(MIGRATION, "utf8");

    expect({
      updatesInvites: sql.startsWith(
        'UPDATE "team_invitations" SET "expires_at" = "competitions"."registration_end_at"',
      ),
      changesShape: ["CREATE", "ALTER", "DROP", "DELETE", "RENAME", "INSERT"].some((word) =>
        sql.includes(word),
      ),
    }).toEqual({ updatesInvites: true, changesShape: false });
  });
});
