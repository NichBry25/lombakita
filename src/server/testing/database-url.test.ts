// @vitest-environment node

// The tripwire that decides whether a database-backed suite RUNS, tested through its own module
// rather than through a caller: every one of the eight suites that import it inherits this decision
// at module load, and getting it wrong is silent by construction — a skipped suite reports the same
// green tick as a passing one, with a lower total that nothing explains.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loads the module fresh with a chosen environment and working directory.
 *
 * The directory matters as much as the variables: the fallback reads `.env.local` out of
 * `process.cwd()`, and the failure this module exists to close is a worktree that has no such file.
 */
const loadIn = async (options: { cwd: string; env: Record<string, string | undefined> }) => {
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(options.cwd);
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import("@/server/testing/database-url");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const emptyWorktree = () => mkdtempSync(join(tmpdir(), "lombakita-no-env-"));

const worktreeWithEnvLocal = (databaseUrl: string) => {
  const dir = mkdtempSync(join(tmpdir(), "lombakita-env-"));
  writeFileSync(join(dir, ".env.local"), `DATABASE_URL=${databaseUrl}\nAPP_ENV=local\n`);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("database-url", () => {
  // THE DEFECT, stated as a test. A worktree with no `.env.local` and no exported DATABASE_URL used
  // to skip 285 tests and say nothing.
  it("refuses to load when no database can be found", async () => {
    await expect(
      loadIn({
        cwd: emptyWorktree(),
        env: { DATABASE_URL: undefined, REQUIRE_DB_TESTS: undefined },
      }),
    ).rejects.toThrow(/No DATABASE_URL is set/);
  });

  it("still refuses when REQUIRE_DB_TESTS holds something other than the opt-out", async () => {
    await expect(
      loadIn({ cwd: emptyWorktree(), env: { DATABASE_URL: undefined, REQUIRE_DB_TESTS: "yes" } }),
    ).rejects.toThrow(/No DATABASE_URL is set/);
  });

  // The opt-out is deliberate and spelled out, for a developer who genuinely has no local Postgres.
  it("skips rather than refuses only on the explicit opt-out", async () => {
    const loaded = await loadIn({
      cwd: emptyWorktree(),
      env: { DATABASE_URL: undefined, REQUIRE_DB_TESTS: "0" },
    });

    expect(loaded.databaseTestsRequired).toBe(false);
    expect(loaded.skipWithoutDatabase).toBe(true);
  });

  it("never skips when a database is present, opt-out or not", async () => {
    const loaded = await loadIn({
      cwd: emptyWorktree(),
      env: { DATABASE_URL: "postgresql://u:p@localhost:5432/db", REQUIRE_DB_TESTS: "0" },
    });

    expect(loaded.skipWithoutDatabase).toBe(false);
  });

  // Rule 33: the connection string comes from a real `.env.local` on disk, read the way the module
  // reads it, not from a value handed straight to the function under test.
  it("reads the connection string out of a real .env.local", async () => {
    const loaded = await loadIn({
      cwd: worktreeWithEnvLocal("postgresql://app:secret@localhost:5432/lombakita_probe"),
      env: { DATABASE_URL: undefined, REQUIRE_DB_TESTS: undefined },
    });

    expect(loaded.TEST_DATABASE_URL).toBe("postgresql://app:secret@localhost:5432/lombakita_probe");
    expect(loaded.skipWithoutDatabase).toBe(false);
  });
});
