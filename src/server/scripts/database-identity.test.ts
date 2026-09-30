// @vitest-environment node
//
// The reader and the comparison, without a database.
//
// `readServerIdentity` takes `IdentifiableConnection` — the structural shape `reset-guard.ts`
// already exports — rather than postgres.js's `Sql`, so the refusals below are reachable against a
// stub. What that buys is the two cases a real server almost never produces and which are therefore
// never exercised by an integration test: a connection that answers with NO row, and one that
// answers with a row whose fields are not names. Both are fail-open if they are not refusals.

import { describe, expect, it } from "vitest";

import { identityMismatch, readServerIdentity } from "@/server/scripts/database-identity";

const connectionReturning = (rows: readonly Record<string, unknown>[]) => ({
  unsafe: async () => rows,
});

describe("identityMismatch", () => {
  const observed = { database: "lombakita_staging", role: "lombakita_migrate" };

  it("returns null when every provided expectation matches", () => {
    expect(
      identityMismatch(observed, { database: "lombakita_staging", role: "lombakita_migrate" }),
    ).toBeNull();
  });

  it("names the database when only the database differs", () => {
    const mismatch = identityMismatch(observed, { database: "lombakita_production" });

    expect(mismatch).toBe(
      'database: observed "lombakita_staging", expected "lombakita_production"',
    );
  });

  it("names the role when only the role differs", () => {
    const mismatch = identityMismatch(observed, { role: "lombakita_app" });

    expect(mismatch).toBe('role: observed "lombakita_migrate", expected "lombakita_app"');
  });

  it("names both fields, so a reader is not told half of what is wrong", () => {
    const mismatch = identityMismatch(observed, {
      database: "lombakita_production",
      role: "lombakita_app",
    });

    expect(mismatch).toBe(
      'database: observed "lombakita_staging", expected "lombakita_production"; ' +
        'role: observed "lombakita_migrate", expected "lombakita_app"',
    );
  });

  // AN EXPECTATION NOT GIVEN IS NOT AN EXPECTATION OF `undefined`. A caller checking only the
  // database must not be refused because the role comparison was silently asserted too.
  it("says nothing about a field no expectation was given for", () => {
    expect(identityMismatch(observed, {})).toBeNull();
    expect(identityMismatch({ database: "", role: "" }, { database: "lombakita_staging" })).toBe(
      'database: observed "", expected "lombakita_staging"',
    );
  });
});

describe("readServerIdentity", () => {
  it("returns the names the server answered with", async () => {
    const identity = await readServerIdentity(
      connectionReturning([{ db: "lombakita_staging", usr: "lombakita_migrate" }]),
    );

    expect(identity).toEqual({ database: "lombakita_staging", role: "lombakita_migrate" });
  });

  it("refuses an empty result rather than reporting an unidentified server", async () => {
    await expect(readServerIdentity(connectionReturning([]))).rejects.toThrow(
      "Connected but the server returned no identity row.",
    );
  });

  it("refuses a row whose fields are not names", async () => {
    await expect(readServerIdentity(connectionReturning([{ db: 7, usr: null }]))).rejects.toThrow(
      "Connected but the server returned no identity row.",
    );
  });
});
