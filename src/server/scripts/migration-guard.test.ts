// @vitest-environment node
//
// The guarded migration entry point, without a database and without spawning anything.
//
// TWO HALVES, AND THEY ARE NOT THE SAME ASSERTION. The decisions are pure and are exercised
// directly — environment resolution, the refusal that replaced CONFIRM_PROD_MIGRATION, the identity
// and confirmation comparisons. The runner is driven end to end with the connection and the child
// process stubbed, because "the migrator receives the URL whose identity was just read" is a
// property of the wiring and a pure test cannot see it (Rule 33).
//
// NO PRODUCTION OR STAGING CONNECTION IS OPENED HERE. `postgres` is mocked, so the only server
// answers in this file are the ones each test writes down. The filesystem is NOT mocked: every test
// that cares what `existsSync` sees runs in a temporary directory it created, which keeps the real
// precedence rules in the measurement rather than a stand-in for them.
//
// Rule 35: every test that changes the working directory or `process.env` restores it in an
// `afterEach` that runs whether or not the assertion threw.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  unsafe: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

vi.mock("postgres", () => ({
  default: vi.fn(() => ({ unsafe: mocks.unsafe, end: mocks.end })),
}));

// The real one imports `@/config/env.server`, which snapshots `process.env` at module load. The
// stubbed version keeps this file independent of DB_SSL_MODE.
vi.mock("@/server/db/ssl-options", () => ({ resolveDatabaseSslOption: () => undefined }));

import {
  findTargetRefusal,
  loadLocalEnvFilesRecordingSources,
  planGuardedMigration,
  run,
  type MigrationPlan,
  type UrlSources,
} from "@/server/scripts/migration-guard";

const SOURCES: UrlSources = {
  MIGRATION_DATABASE_URL: "shell",
  DATABASE_URL: "shell",
};

const LOCAL_URL = "postgres://user:password@127.0.0.1:5432/lombakita_dev";
const REMOTE_URL = "postgres://user:password@db.example.test:5432/lombakita_dev";

const planOf = (input: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  sources?: UrlSources;
}) =>
  planGuardedMigration({
    argv: input.argv ?? [],
    env: input.env ?? { DATABASE_URL: LOCAL_URL },
    sources: input.sources ?? SOURCES,
  });

/** The plan from a decision that must have been accepted, so a refusal cannot pass as a plan. */
const accepted = (input: Parameters<typeof planOf>[0]): MigrationPlan => {
  const decision = planOf(input);

  if (decision.kind !== "ready") {
    throw new Error(`expected a plan, got a refusal: ${decision.message}`);
  }

  return decision.plan;
};

const refusalOf = (input: Parameters<typeof planOf>[0]): string => {
  const decision = planOf(input);

  if (decision.kind !== "refused") {
    throw new Error("expected a refusal, got a plan");
  }

  return decision.message;
};

// ---------------------------------------------------------------------------------------------
// The pure half.
// ---------------------------------------------------------------------------------------------

describe("planGuardedMigration — the declared environment", () => {
  it("resolves an absent --environment to local and SAYS it defaulted", () => {
    const plan = accepted({ argv: [], env: { DATABASE_URL: LOCAL_URL } });

    expect(plan.environment).toBe("local");
    expect(plan.environmentLabel).toBe("local (default)");
  });

  it("reports an explicit --environment=local without claiming a default", () => {
    const plan = accepted({ argv: ["--environment=local"], env: { DATABASE_URL: LOCAL_URL } });

    expect(plan.environment).toBe("local");
    expect(plan.environmentLabel).toBe("local");
  });

  it("refuses an unknown environment with a usage line", () => {
    const message = refusalOf({
      argv: ["--environment=staging"],
      env: { DATABASE_URL: LOCAL_URL },
    });

    expect(message).toContain('Unknown --environment "staging"');
    expect(message).toContain("Usage: npm run db:migrate:guarded");
  });
});

describe("planGuardedMigration — the target and its source", () => {
  it("prefers MIGRATION_DATABASE_URL and names it as the variable that supplied the target", () => {
    const plan = accepted({
      env: { MIGRATION_DATABASE_URL: REMOTE_URL, DATABASE_URL: LOCAL_URL },
      sources: { MIGRATION_DATABASE_URL: "file:.env.local", DATABASE_URL: "shell" },
    });

    expect(plan.url).toBe(REMOTE_URL);
    expect(plan.variable).toBe("MIGRATION_DATABASE_URL");
    expect(plan.source).toBe("file:.env.local");
  });

  it("falls back to DATABASE_URL and reports that source instead", () => {
    const plan = accepted({
      env: { DATABASE_URL: LOCAL_URL },
      sources: { MIGRATION_DATABASE_URL: "unset", DATABASE_URL: "shell" },
    });

    expect(plan.variable).toBe("DATABASE_URL");
    expect(plan.source).toBe("shell");
  });

  it("refuses when neither variable names a target", () => {
    expect(refusalOf({ env: {} })).toBe(
      "DATABASE_URL or MIGRATION_DATABASE_URL must be configured before running migrations",
    );
  });
});

describe("planGuardedMigration — CONFIRM_PROD_MIGRATION is never authorisation", () => {
  it("refuses on presence alone, even carrying the value that used to authorise", () => {
    const decision = planOf({
      env: { DATABASE_URL: LOCAL_URL, CONFIRM_PROD_MIGRATION: "YES_I_UNDERSTAND" },
    });

    expect(decision).toEqual({
      kind: "refused",
      message:
        "CONFIRM_PROD_MIGRATION is no longer read. Remove it from your shell and env files; " +
        "confirm with --confirm=<database name> instead.",
    });
  });

  it("refuses on presence alone for a value that never authorised anything", () => {
    expect(refusalOf({ env: { DATABASE_URL: LOCAL_URL, CONFIRM_PROD_MIGRATION: "no" } })).toContain(
      "CONFIRM_PROD_MIGRATION is no longer read",
    );
  });
});

describe("planGuardedMigration — the typed confirmation", () => {
  it("refuses preview without --confirm", () => {
    const message = refusalOf({
      argv: ["--environment=preview"],
      env: { MIGRATION_DATABASE_URL: LOCAL_URL },
    });

    expect(message).toContain("--environment=preview requires --confirm=<database name>");
  });

  it("refuses production without --confirm", () => {
    expect(
      refusalOf({
        argv: ["--environment=production"],
        env: { MIGRATION_DATABASE_URL: LOCAL_URL },
      }),
    ).toContain("--environment=production requires --confirm=<database name>");
  });

  it("carries the confirmation through for preview and production", () => {
    expect(
      accepted({
        argv: ["--environment=preview", "--confirm=lombakita_staging"],
        env: { MIGRATION_DATABASE_URL: LOCAL_URL },
      }).confirm,
    ).toBe("lombakita_staging");

    expect(
      accepted({
        argv: ["--environment=production", "--confirm=lombakita_production"],
        env: { MIGRATION_DATABASE_URL: LOCAL_URL },
      }).confirm,
    ).toBe("lombakita_production");
  });

  // IGNORED, NOT REFUSED. A `--confirm` under local is muscle memory from a managed run, and
  // refusing it would refuse a command that names the right target.
  it("carries --confirm under local without treating it as a requirement", () => {
    const plan = accepted({
      argv: ["--confirm=lombakita_staging"],
      env: { MIGRATION_DATABASE_URL: LOCAL_URL },
    });

    expect(plan.environment).toBe("local");
    expect(plan.confirm).toBe("lombakita_staging");
    expect(
      findTargetRefusal({
        plan,
        identity: { database: "lombakita_dev", role: "lombakita_migrate" },
      }),
    ).toBeNull();
  });
});

describe("findTargetRefusal — local", () => {
  const localPlan = accepted({ env: { DATABASE_URL: LOCAL_URL } });

  it("permits a loopback database under a name nothing protects", () => {
    expect(
      findTargetRefusal({
        plan: localPlan,
        identity: { database: "lombakita_dev", role: "lombakita_migrate" },
      }),
    ).toBeNull();
  });

  // THE DEFAULT MUST NEVER REACH A REMOTE DATABASE. This is the case a forgotten --environment
  // produces, and it is refused rather than migrated however the operator's shell is set up.
  it("refuses a non-loopback host", () => {
    const refusal = findTargetRefusal({
      plan: accepted({ env: { DATABASE_URL: REMOTE_URL } }),
      identity: { database: "lombakita_dev", role: "lombakita_migrate" },
    });

    expect(refusal).toContain("refusing to migrate");
    expect(refusal).toContain('"db.example.test"');
    expect(refusal).toContain("not loopback");
  });

  it("refuses a database the SERVER says is one of the deployed names", () => {
    const refusal = findTargetRefusal({
      plan: localPlan,
      identity: { database: "lombakita_production", role: "lombakita_migrate" },
    });

    expect(refusal).toContain('current_database() = "lombakita_production"');
    expect(refusal).toContain("protected database");
  });
});

describe("findTargetRefusal — preview and production", () => {
  const previewPlan = accepted({
    argv: ["--environment=preview", "--confirm=lombakita_staging"],
    env: { MIGRATION_DATABASE_URL: REMOTE_URL },
  });

  const matching = { database: "lombakita_staging", role: "lombakita_migrate" };

  it("permits the declared database as the declared role", () => {
    expect(findTargetRefusal({ plan: previewPlan, identity: matching })).toBeNull();
  });

  it("refuses a database mismatch", () => {
    const refusal = findTargetRefusal({
      plan: previewPlan,
      identity: { database: "lombakita_dev", role: "lombakita_migrate" },
    });

    expect(refusal).toContain('Connected to database "lombakita_dev" as "lombakita_migrate"');
    expect(refusal).toContain('"lombakita_staging" as "lombakita_migrate"');
  });

  // THE ROLE IS THE HALF A NAME CHECK CANNOT SEE. A credential can reach the right database and
  // still be a different identity there, which is what the migration role is pinned against.
  it("refuses a role mismatch on the right database", () => {
    const refusal = findTargetRefusal({
      plan: previewPlan,
      identity: { database: "lombakita_staging", role: "lombakita_app" },
    });

    expect(refusal).toContain('Connected to database "lombakita_staging" as "lombakita_app"');
    expect(refusal).toContain('as "lombakita_migrate"');
  });

  // COMPARED AGAINST WHAT THE SERVER SAID, NOT AGAINST THE TABLE. The confirmation below equals a
  // canonical database name — the wrong one — so a check written against the constant would accept
  // it. It is refused.
  it("refuses a --confirm naming the other environment's database", () => {
    const refusal = findTargetRefusal({
      plan: accepted({
        argv: ["--environment=preview", "--confirm=lombakita_production"],
        env: { MIGRATION_DATABASE_URL: REMOTE_URL },
      }),
      identity: matching,
    });

    expect(refusal).toContain('--confirm="lombakita_production" does not match');
    expect(refusal).toContain('"lombakita_staging"');
  });

  it("accepts the typed name for production and refuses the stale one", () => {
    const productionPlan = (confirm: string) =>
      accepted({
        argv: ["--environment=production", `--confirm=${confirm}`],
        env: { MIGRATION_DATABASE_URL: REMOTE_URL },
      });

    const identity = { database: "lombakita_production", role: "lombakita_migrate" };

    expect(
      findTargetRefusal({ plan: productionPlan("lombakita_production"), identity }),
    ).toBeNull();
    expect(findTargetRefusal({ plan: productionPlan("lombakita_staging"), identity })).toContain(
      "does not match",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------------------------

const createdDirectories: string[] = [];

/** A directory with the fixtures the runner reads and none of the ones it must not. */
const withWorkingDirectory = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "lombakita-migration-guard-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(directory, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  createdDirectories.push(directory);
  process.chdir(directory);

  return directory;
};

const ENV_KEYS = ["MIGRATION_DATABASE_URL", "DATABASE_URL", "CONFIRM_PROD_MIGRATION"] as const;

let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
let savedArgv: string[];
let savedExitCode: number | string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  savedCwd = process.cwd();
  savedArgv = process.argv;
  savedExitCode = process.exitCode;

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  mocks.spawnSync.mockReset().mockReturnValue({ status: 0, signal: null });
  mocks.unsafe.mockReset().mockResolvedValue([{ db: "lombakita_dev", usr: "lombakita_migrate" }]);
  mocks.end.mockReset().mockResolvedValue(undefined);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Rule 35: teardown runs where its own failure cannot suppress it, and restores what it changed.
  process.chdir(savedCwd);

  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }

  process.argv = savedArgv;
  process.exitCode = savedExitCode;

  for (const key of ENV_KEYS) {
    const value = savedEnv[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("loadLocalEnvFilesRecordingSources", () => {
  it("attributes a value that was already exported to the shell, whatever the files say", () => {
    withWorkingDirectory({});
    process.env.DATABASE_URL = LOCAL_URL;

    const sources = loadLocalEnvFilesRecordingSources();

    expect(sources.DATABASE_URL).toBe("shell");
    expect(sources.MIGRATION_DATABASE_URL).toBe("unset");
  });

  // THE FILE IS READ FOR REAL, so the precedence is measured rather than described. A hand-built
  // source map would prove the branch and nothing about LAUNCH-D151.
  it("attributes a value the file introduced to that file, by name", () => {
    withWorkingDirectory({ ".env.local": `DATABASE_URL=${LOCAL_URL}\n` });

    const sources = loadLocalEnvFilesRecordingSources();

    expect(sources.DATABASE_URL).toBe("file:.env.local");
    expect(sources.MIGRATION_DATABASE_URL).toBe("unset");
  });

  it("falls through to .env when .env.local is absent, and names the file it used", () => {
    withWorkingDirectory({ ".env": `DATABASE_URL=${LOCAL_URL}\n` });

    expect(loadLocalEnvFilesRecordingSources().DATABASE_URL).toBe("file:.env");
  });

  it("prefers the shell over the file that also sets the variable, and reports the shell", () => {
    withWorkingDirectory({ ".env.local": "DATABASE_URL=postgres://file@127.0.0.1:5432/other\n" });
    process.env.DATABASE_URL = LOCAL_URL;

    const sources = loadLocalEnvFilesRecordingSources();

    // `process.loadEnvFile` does not override a set variable, so the shell wins AND is named.
    expect(sources.DATABASE_URL).toBe("shell");
    expect(process.env.DATABASE_URL).toBe(LOCAL_URL);
  });
});

describe("run — the wiring between the verified identity and the migrator", () => {
  const inReadyDirectory = (): void => {
    withWorkingDirectory({ "node_modules/.bin/drizzle-kit": "#!/bin/sh\n" });
  };

  const printedTarget = (): string => {
    const line = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.startsWith("migration target: "));

    if (line === undefined) throw new Error("no target line was printed");

    return line;
  };

  const refusingExit = (): MockInstance =>
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

  it("prints the server's own answer, and hands the migrator the URL it verified", async () => {
    inReadyDirectory();
    process.argv = ["node", "migration-guard.ts"];
    process.env.MIGRATION_DATABASE_URL = LOCAL_URL;

    await run();

    expect(printedTarget()).toBe(
      "migration target: database=lombakita_dev role=lombakita_migrate host=127.0.0.1 " +
        "source=shell environment=local (default)",
    );

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    const [binary, args, options] = mocks.spawnSync.mock.calls[0] as [
      string,
      string[],
      { stdio: string; env: Record<string, string> },
    ];

    expect(binary.endsWith("node_modules/.bin/drizzle-kit")).toBe(true);
    expect(args).toEqual(["migrate"]);
    expect(options.stdio).toBe("inherit");
    expect(options.env.MIGRATION_DATABASE_URL).toBe(LOCAL_URL);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it("never prints the credential, the user out of the URL or the password", async () => {
    inReadyDirectory();
    process.argv = ["node", "migration-guard.ts"];
    process.env.MIGRATION_DATABASE_URL = LOCAL_URL;

    await run();

    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      const text = call.map(String).join(" ");

      expect(text).not.toContain("password");
      expect(text).not.toContain("user:");
      expect(text).not.toContain(LOCAL_URL);
    }
  });

  it("exits 1 when the migrator was ended by a signal, not with a status it never gave", async () => {
    inReadyDirectory();
    process.argv = ["node", "migration-guard.ts"];
    process.env.MIGRATION_DATABASE_URL = LOCAL_URL;
    mocks.spawnSync.mockReturnValue({ status: null, signal: "SIGKILL" });

    await run();

    expect(process.exitCode).toBe(1);
  });

  // THE ORDER THE OPERATOR NEEDS: which database refused, and why. A refusal that printed nothing
  // about the target would leave a stale exported URL invisible on exactly the run that reveals it.
  it("prints the target line before refusing a non-loopback default, and migrates nothing", async () => {
    inReadyDirectory();
    process.argv = ["node", "migration-guard.ts"];
    process.env.MIGRATION_DATABASE_URL = REMOTE_URL;

    const exit = refusingExit();

    try {
      await expect(run()).rejects.toThrow("process.exit(1)");
    } finally {
      exit.mockRestore();
    }

    expect(printedTarget()).toContain("host=db.example.test");
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "REFUSED: refusing to migrate",
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("refuses without connecting when the confirmation the arguments require is absent", async () => {
    inReadyDirectory();
    process.argv = ["node", "migration-guard.ts", "--environment=production"];
    process.env.MIGRATION_DATABASE_URL = REMOTE_URL;

    const exit = refusingExit();

    try {
      await expect(run()).rejects.toThrow("process.exit(1)");
    } finally {
      exit.mockRestore();
    }

    expect(mocks.unsafe).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "migration target:",
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  // A RUN THAT CANNOT FIND THE MIGRATOR MUST NOT REPORT SUCCESS. This is the failure the old
  // two-process script had no way to express: the guard passed, the second command was a different
  // program, and nothing checked that it ever started.
  it("refuses when drizzle-kit is not installed, rather than reporting a run that never happened", async () => {
    withWorkingDirectory({});
    process.argv = ["node", "migration-guard.ts"];
    process.env.MIGRATION_DATABASE_URL = LOCAL_URL;

    const exit = refusingExit();

    try {
      await expect(run()).rejects.toThrow("process.exit(1)");
    } finally {
      exit.mockRestore();
    }

    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "drizzle-kit is not installed",
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
