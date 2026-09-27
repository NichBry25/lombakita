// @vitest-environment node
//
// The comparison, without a database.
//
// `assertDatabaseIdentity` takes `IdentifiableConnection` — the structural shape `reset-guard.ts`
// exports — so every refusal here is reachable against a stub. What that buys is exactly the cases a
// deploy gate meets once and must not get wrong: the RIGHT database as the WRONG role, and a server
// that did not name itself at all.
//
// WHAT THIS FILE DOES NOT COVER, and cannot: that `probeDatabaseIdentity` opens a real connection
// with DATABASE_URL and closes it. That half is the socket, and it is proved against a real loopback
// database in the manual demonstration reported with this pass.
//
// The stub answers in the field names the SERVER answers in (`db`, `usr`), not in the reader's own
// names for them, so a reader that stopped reading those columns would go red here.

import { describe, expect, it } from "vitest";

import { assertDatabaseIdentity } from "@/server/db/database-identity-probe";

const connectionAnswering = (row: Record<string, unknown>) => ({
  unsafe: async () => [row],
});

describe("assertDatabaseIdentity", () => {
  it("passes when the server answers as the declared environment's database and runtime role", async () => {
    const connection = connectionAnswering({ db: "lombakita_staging", usr: "lombakita_app" });

    await expect(assertDatabaseIdentity(connection, "preview")).resolves.toBeUndefined();
  });

  // THE CASE DEC-0207 IS ABOUT, ONE FIELD FURTHER IN. Reaching the right database as the wrong role
  // is a credential that can do a different set of things there than this lane assumes, and the
  // database-name comparison alone cannot see it.
  it("refuses a server answering as the migration role where the runtime role is required", async () => {
    const connection = connectionAnswering({ db: "lombakita_staging", usr: "lombakita_migrate" });

    await expect(assertDatabaseIdentity(connection, "preview")).rejects.toThrow(
      'role: observed "lombakita_migrate", expected "lombakita_app"',
    );
  });

  it("refuses a server answering from the wrong database for a declared environment", async () => {
    const connection = connectionAnswering({
      db: "lombakita_production",
      usr: "lombakita_app",
    });

    await expect(assertDatabaseIdentity(connection, "preview")).rejects.toThrow(
      'database: observed "lombakita_production", expected "lombakita_staging"',
    );
  });

  // AN UNIDENTIFIED SERVER IS NOT A MATCH. Reached here through this module rather than only through
  // the reader's own suite, because this is the caller that decides what an unidentified server
  // means for a deploy gate.
  it("refuses a server that did not name itself, rather than reading it as a match", async () => {
    await expect(assertDatabaseIdentity({ unsafe: async () => [] }, "production")).rejects.toThrow(
      "Connected but the server returned no identity row.",
    );
  });
});
