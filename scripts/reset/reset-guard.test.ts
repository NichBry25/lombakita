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
} from "./reset-guard";

const LOCAL_URL = "postgres://user:pass@localhost:5432/lombakita";
const REMOTE_URL = "postgres://user:pass@ep-thing.ap-southeast-1.aws.neon.tech/lombakita";

/** A connection that answers `current_database()` with whatever this test needs it to say. */
const serverReporting = (databaseName: string) => ({
  unsafe: async () => [{ db: databaseName, usr: "someone" }],
});

const disposableContext = {
  appEnv: "local" as const,
  databaseUrl: LOCAL_URL,
  redisUrl: "redis://localhost:6379",
};

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
    const refusal = findDatabaseNameRefusal("lombakita_production");

    expect(refusal?.layer).toBe("database-identity");
    expect(refusal?.message).toContain("lombakita_production");
    expect(refusal?.message).toContain("current_database()");
  });

  it("refuses the staging database", () => {
    expect(findDatabaseNameRefusal("lombakita_staging")?.layer).toBe("database-identity");
  });

  it("permits a database that is not protected", () => {
    expect(findDatabaseNameRefusal("lombakita")).toBeNull();
    expect(findDatabaseNameRefusal("lombakita_ci")).toBeNull();
  });
});

describe("the environment layer", () => {
  it.each(["production", "preview", "staging"] as const)("refuses %s", (appEnv) => {
    const refusal = findEnvironmentRefusal(appEnv);

    expect(refusal?.layer).toBe("environment");
    expect(refusal?.message).toContain(appEnv);
  });

  it.each(["local", "test"] as const)("permits %s", (appEnv) => {
    expect(findEnvironmentRefusal(appEnv)).toBeNull();
  });

  // An ALLOW-LIST is the whole point: a deny-list would have to enumerate every way of being
  // production, and would permit whichever one it had not thought of.
  it("refuses an environment nobody has classified", () => {
    expect(findEnvironmentRefusal("staging-two" as never)?.layer).toBe("environment");
  });
});

describe("the connection-host layer", () => {
  it("refuses a remote host", () => {
    const refusal = findConnectionHostRefusal(REMOTE_URL, "DATABASE_URL");

    expect(refusal?.layer).toBe("connection-host");
    expect(refusal?.message).toContain("ep-thing.ap-southeast-1.aws.neon.tech");
  });

  it("permits loopback in every spelling, including bracketed IPv6", () => {
    expect(findConnectionHostRefusal(LOCAL_URL, "DATABASE_URL")).toBeNull();
    expect(findConnectionHostRefusal("postgres://u:p@127.0.0.1/db", "DATABASE_URL")).toBeNull();
    expect(findConnectionHostRefusal("postgres://u:p@[::1]:5432/db", "DATABASE_URL")).toBeNull();
  });

  // An unparseable string is refused rather than waved through: a caller uses this to decide
  // whether it may destroy a database, and a string this cannot read is not one to destroy through.
  it("refuses a string it cannot parse", () => {
    expect(findConnectionHostRefusal("not-a-url", "DATABASE_URL")?.layer).toBe("connection-host");
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

      expect(findEnvironmentRefusal(declaredAppEnvironment())).not.toBeNull();
    }
  });
});
