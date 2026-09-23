/**
 * What the reset guard refuses, and why each refusal is the one it claims to be.
 *
 * These are unit tests over hand-constructed inputs, and Rule 33 says that proves the FUNCTION and
 * not the WIRING. The wiring is proven separately and deliberately:
 *   - `scripts/testing/probes/reset-guard.mjs` runs the real `npm run db:reset` against real local
 *     databases named in `PROBE_DATABASES`, one per layer so that each layer is the only thing that
 *     can refuse its own run, and proves the guard's POSITION by moving it below the drop and
 *     observing the drop happen.
 *   - The identity layer cannot be unit-tested for the property that matters. Its whole claim is
 *     that the answer comes from the SERVER rather than from the string used to reach it, so a stub
 *     returning a name proves only that the code reads the field it says it reads. That the server
 *     is what answers is shown by the probes, against a database whose name is the refusal.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  PROTECTED_DATABASE_NAMES,
  ResetRefused,
  assertResetTargetIsDisposable,
  declaredAppEnvironment,
  findConnectionHostRefusal,
  findDatabaseNameRefusal,
  findEnvironmentRefusal,
  resolveResetTarget,
} from "./reset-guard";

const LOCAL_URL = "postgres://user:pass@localhost:5432/lombakita";
const REMOTE_URL = "postgres://user:pass@ep-thing.ap-southeast-1.aws.neon.tech/lombakita";

/** A connection that answers `current_database()` with whatever this test needs it to say. */
const serverReporting = (databaseName: string) => ({
  unsafe: async () => [{ db: databaseName, usr: "someone" }],
});

const disposableContext = {
  verb: "reset" as const,
  appEnv: "local" as const,
  databaseUrl: LOCAL_URL,
  redisUrl: "redis://localhost:6379",
};

/**
 * Which database the reset resolves, and whether a refusal from here says so.
 *
 * The layer tags are the subject, not a detail. A refusal that does not name its layer is what
 * produced Stage 9's false reading: an operator set `MIGRATION_DATABASE_URL` alone at a protected
 * database to exercise the IDENTITY layer, the COHERENCE check refused first because that is
 * exactly what changing one variable does, and an unlabelled `REFUSED` was read as the identity
 * layer holding. These assert that the two refusals from this function are distinguishable from the
 * three safety layers and from each other.
 */
describe("resolving which database the reset targets", () => {
  const original = {
    migration: process.env.MIGRATION_DATABASE_URL,
    database: process.env.DATABASE_URL,
  };

  const withUrls = (migration: string | undefined, database: string | undefined): void => {
    for (const [key, value] of [
      ["MIGRATION_DATABASE_URL", migration],
      ["DATABASE_URL", database],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  afterEach(() => {
    withUrls(original.migration, original.database);
  });

  const refusalFrom = (migration: string | undefined, database: string | undefined): unknown => {
    withUrls(migration, database);

    try {
      resolveResetTarget("reset");
    } catch (error: unknown) {
      return error;
    }

    return null;
  };

  it("refuses as target-configuration when neither variable names a database", () => {
    const refused = refusalFrom(undefined, undefined);

    expect(refused).toBeInstanceOf(ResetRefused);
    expect((refused as ResetRefused).layer).toBe("target-configuration");
  });

  // The coherence refusal must be TOLD APART from the identity layer, because the one way an
  // operator reaches it is by trying to exercise the identity layer.
  it("refuses as target-coherence, not database-identity, when the two addresses disagree", () => {
    const refused = refusalFrom(REMOTE_URL, LOCAL_URL);

    expect(refused).toBeInstanceOf(ResetRefused);
    expect((refused as ResetRefused).layer).toBe("target-coherence");
    expect((refused as ResetRefused).layer).not.toBe("database-identity");
  });

  // Not a message-shape assertion for its own sake: the operator who reaches this refusal believes
  // they are testing something else, so the message has to say which check fired and what to do
  // instead. Without this the layer tag is right and the human-readable half stays wrong.
  it("tells the operator the identity layer was never reached", () => {
    const refused = refusalFrom(REMOTE_URL, LOCAL_URL) as ResetRefused;

    expect(refused.message).toMatch(/NOT the database-identity layer/);
    expect(refused.message).toMatch(/point both at that database/);
  });

  // An EMPTY variable is absent, not a value. With `??` the empty migration URL shadowed a set
  // DATABASE_URL, the target resolved to "", and this refused "must be set" while DATABASE_URL was
  // set the whole time. Same class as the REDIS_URL fix, same fix.
  it("treats an empty MIGRATION_DATABASE_URL as absent and falls back to DATABASE_URL", () => {
    withUrls("", LOCAL_URL);

    expect(resolveResetTarget("reset")).toBe(LOCAL_URL);
  });

  it("treats an empty DATABASE_URL as absent and uses MIGRATION_DATABASE_URL", () => {
    withUrls(LOCAL_URL, "");

    expect(resolveResetTarget("reset")).toBe(LOCAL_URL);
  });

  // Two roles against one database is the arrangement working correctly, not a disagreement. A
  // whole-string comparison here would refuse every properly configured machine.
  it("permits two different roles against the same address", () => {
    withUrls(
      "postgres://lombakita_migrate:pw@localhost:5432/lombakita",
      "postgres://lombakita_app:pw@localhost:5432/lombakita",
    );

    expect(resolveResetTarget("reset")).toContain("lombakita_migrate");
  });
});

describe("the protected database list", () => {
  // Sourced from the deploy gate's own table rather than restated, so an environment added there
  // is protected here without anyone remembering to do it twice. If this ever fails, the two have
  // drifted and one of the databases is unprotected.
  it("covers both databases the deploy gate knows about", () => {
    expect(PROTECTED_DATABASE_NAMES).toContain("lombakita_production");
    expect(PROTECTED_DATABASE_NAMES).toContain("lombakita_staging");
  });
});

describe("the database-identity layer", () => {
  it("refuses the production database by the name the server reported", () => {
    const refusal = findDatabaseNameRefusal("reset", "lombakita_production");

    expect(refusal?.layer).toBe("database-identity");
    expect(refusal?.message).toContain("lombakita_production");
    expect(refusal?.message).toContain("current_database()");
  });

  it("refuses the staging database", () => {
    expect(findDatabaseNameRefusal("reset", "lombakita_staging")?.layer).toBe("database-identity");
  });

  it("permits a database that is not protected", () => {
    expect(findDatabaseNameRefusal("reset", "lombakita")).toBeNull();
    expect(findDatabaseNameRefusal("reset", "lombakita_ci")).toBeNull();
  });
});

describe("the environment layer", () => {
  it.each(["production", "preview", "staging"] as const)("refuses %s", (appEnv) => {
    const refusal = findEnvironmentRefusal("reset", appEnv);

    expect(refusal?.layer).toBe("environment");
    expect(refusal?.message).toContain(appEnv);
  });

  it.each(["local", "test"] as const)("permits %s", (appEnv) => {
    expect(findEnvironmentRefusal("reset", appEnv)).toBeNull();
  });

  // An ALLOW-LIST is the whole point: a deny-list would have to enumerate every way of being
  // production, and would permit whichever one it had not thought of.
  it("refuses an environment nobody has classified", () => {
    expect(findEnvironmentRefusal("reset", "staging-two" as never)?.layer).toBe("environment");
  });
});

describe("the connection-host layer", () => {
  it("refuses a remote host", () => {
    const refusal = findConnectionHostRefusal("reset", REMOTE_URL, "DATABASE_URL");

    expect(refusal?.layer).toBe("connection-host");
    expect(refusal?.message).toContain("ep-thing.ap-southeast-1.aws.neon.tech");
  });

  it("permits loopback in every spelling, including bracketed IPv6", () => {
    expect(findConnectionHostRefusal("reset", LOCAL_URL, "DATABASE_URL")).toBeNull();
    expect(findConnectionHostRefusal("reset", "postgres://u:p@127.0.0.1/db", "DATABASE_URL")).toBeNull();
    expect(findConnectionHostRefusal("reset", "postgres://u:p@[::1]:5432/db", "DATABASE_URL")).toBeNull();
  });

  // An unparseable string is refused rather than waved through: a caller uses this to decide
  // whether it may destroy a database, and a string this cannot read is not one to destroy through.
  it("refuses a string it cannot parse", () => {
    expect(findConnectionHostRefusal("reset", "not-a-url", "DATABASE_URL")?.layer).toBe("connection-host");
  });
});

/**
 * The verb, and why it is a parameter rather than a constant.
 *
 * Three lanes connect through this guard and each one refuses a different operation. A deletion
 * runner whose refusal said "refusing to reset" named an operation its operator had not asked for
 * (LAUNCH-D144), and the blast radius of the two is not the same thing to be wrong about. The reset
 * lane's own bytes are pinned separately, by the probe suite and by the reset lane's output being
 * diffed before and after the parameter existed.
 */
describe("the verb a refusal speaks in", () => {
  it.each(["reset", "delete", "provision"] as const)("says %s in every layer's message", (verb) => {
    const messages = [
      findDatabaseNameRefusal(verb, "lombakita_production")?.message,
      findEnvironmentRefusal(verb, "production")?.message,
      findConnectionHostRefusal(verb, REMOTE_URL, "DATABASE_URL")?.message,
    ];

    const others = (["reset", "delete", "provision"] as const).filter((other) => other !== verb);

    for (const message of messages) {
      expect(message).toContain(`refusing to ${verb}: `);
      for (const other of others) {
        expect(message).not.toContain(`refusing to ${other}: `);
      }
    }
  });

  it("passes the caller's verb through to the thrown error", async () => {
    const refused = await assertResetTargetIsDisposable(serverReporting("lombakita"), {
      ...disposableContext,
      verb: "delete",
      appEnv: "production",
    }).catch((error: unknown) => error);

    expect((refused as ResetRefused).message).toContain('refusing to delete: APP_ENV resolves to');
  });
});

describe("assertResetTargetIsDisposable", () => {
  it("permits a disposable local target", async () => {
    await expect(
      assertResetTargetIsDisposable(serverReporting("lombakita"), disposableContext),
    ).resolves.toBeUndefined();
  });

  it("refuses on the name the SERVER reports, not the one in the connection string", async () => {
    // The connection string says `lombakita` and the server says `lombakita_production`. This is
    // LAUNCH-D24's shape exactly, and the refusal has to follow the server.
    await expect(
      assertResetTargetIsDisposable(serverReporting("lombakita_production"), disposableContext),
    ).rejects.toThrow(ResetRefused);
  });

  it("refuses a production environment even when the database name is permitted", async () => {
    await expect(
      assertResetTargetIsDisposable(serverReporting("lombakita"), {
        ...disposableContext,
        appEnv: "production",
      }),
    ).rejects.toThrow(/APP_ENV resolves to "production"/);
  });

  it("refuses a remote REDIS_URL even when the database is disposable", async () => {
    await expect(
      assertResetTargetIsDisposable(serverReporting("lombakita"), {
        ...disposableContext,
        redisUrl: "redis://redis.railway.internal:6379",
      }),
    ).rejects.toThrow(/REDIS_URL/);
  });

  // FAIL CLOSED. A server that answered nothing has not been identified, and an unidentified
  // server is the one case this must never wave through.
  it("refuses when the server returns no identity row", async () => {
    await expect(
      assertResetTargetIsDisposable({ unsafe: async () => [] }, disposableContext),
    ).rejects.toThrow(/no identity row/);
  });

  it("refuses when the server returns a row with no database name", async () => {
    await expect(
      assertResetTargetIsDisposable(
        { unsafe: async () => [{ usr: "someone" }] },
        disposableContext,
      ),
    ).rejects.toThrow(/no identity row/);
  });

  // Each layer must be identifiable, because a probe asserts it went red for the reason it claims.
  // A guard that refuses for the wrong reason is a guard that will permit for the wrong reason.
  it("names which layer refused", async () => {
    const refused = await assertResetTargetIsDisposable(serverReporting("lombakita"), {
      ...disposableContext,
      appEnv: "production",
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ResetRefused);
    expect((refused as ResetRefused).layer).toBe("environment");
  });
});

/**
 * Which environment the process believes it is in, read from two variables.
 *
 * The empty-string case is the one that matters and the one that was wrong. `??` treats "" as a
 * value, so an APP_ENV set to nothing SHADOWED a correctly set NEXT_PUBLIC_APP_ENV, the resolver
 * fell through to its own "local" default, and the environment layer permitted a reset in a process
 * whose only environment declaration said production.
 */
describe("the declared environment", () => {
  const original = { app: process.env.APP_ENV, publicApp: process.env.NEXT_PUBLIC_APP_ENV };

  const withEnvironment = (app: string | undefined, publicApp: string | undefined) => {
    if (app === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = app;
    }

    if (publicApp === undefined) {
      delete process.env.NEXT_PUBLIC_APP_ENV;
    } else {
      process.env.NEXT_PUBLIC_APP_ENV = publicApp;
    }
  };

  afterEach(() => {
    withEnvironment(original.app, original.publicApp);
  });

  it("reads APP_ENV when it carries a value", () => {
    withEnvironment("production", undefined);

    expect(declaredAppEnvironment()).toBe("production");
  });

  it("falls back to NEXT_PUBLIC_APP_ENV when APP_ENV is unset", () => {
    withEnvironment(undefined, "production");

    expect(declaredAppEnvironment()).toBe("production");
  });

  it("treats an EMPTY APP_ENV as absent rather than letting it shadow the fallback", () => {
    withEnvironment("", "production");

    expect(declaredAppEnvironment()).toBe("production");
  });

  it("treats a whitespace-only APP_ENV as absent too", () => {
    withEnvironment("   ", "production");

    expect(declaredAppEnvironment()).toBe("production");
  });

  // The consequence, stated as the thing that actually matters: whatever route the value arrives
  // by, a process declaring production is refused.
  it("refuses a reset in a process that declares production by either variable", () => {
    for (const [app, publicApp] of [
      ["production", undefined],
      [undefined, "production"],
      ["", "production"],
    ] as const) {
      withEnvironment(app, publicApp);

      expect(findEnvironmentRefusal("reset", declaredAppEnvironment())).not.toBeNull();
    }
  });
});
