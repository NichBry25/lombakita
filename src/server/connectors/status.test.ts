// @vitest-environment node
//
// WHERE AND HOW THE RUNTIME IDENTITY CHECK RUNS, and what the payload says when it does not.
//
// EVERY CONNECTOR BELOW IS MOCKED, and that is a condition of the test rather than a convenience:
// the payload this file drives is the deploy gate's, so an unmocked run would open a real connection
// to every configured service from the test suite. The two halves of the identity check are proved
// against each other: `assertDatabaseIdentity` is the real one from the module under test, and only
// the function that opens the socket is replaced. A mismatch here therefore travels the same path a
// deploy gate travels — comparison, refusal, `runConnectorProbe`, entry — minus the socket.
//
// WHAT IS NOT COVERED HERE: that `probeDatabaseIdentity` opens a connection with DATABASE_URL and
// closes it in a `finally`. That is the socket, and it is proved against a real loopback database in
// the manual demonstration reported with this pass.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeployEnvironment } from "@/config/env-shape";
import { getConnectorStatusPayload } from "@/server/connectors/status";
import type { ConnectorStatusPayload } from "@/server/connectors/status";

/** What the stubbed server answers with. Set per test. */
const server = vi.hoisted(() => ({ rows: [] as readonly Record<string, unknown>[] }));

// /api/health gates its live checks on this, and the health case below is only meaningful when they
// are genuinely on. Hoisted above the imports so `env.server`'s snapshot of `process.env` sees it.
vi.hoisted(() => {
  process.env.CONNECTOR_HEALTH_PROBE_ENABLED = "true";
});

vi.mock("@/server/db/database-identity-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/database-identity-probe")>();

  return {
    ...actual,
    // The real comparison over a stubbed connection, so this file measures the branch rather than a
    // second copy of the refusal.
    probeDatabaseIdentity: (environment: DeployEnvironment) =>
      actual.assertDatabaseIdentity({ unsafe: async () => server.rows }, environment),
  };
});

vi.mock("@/server/db/probe", () => ({
  isDatabaseConfigured: () => true,
  probeDatabase: async () => undefined,
}));

vi.mock("@/server/db/migration-database-probe", () => ({
  isMigrationDatabaseConfigured: () => true,
  probeMigrationDatabase: async () => undefined,
}));

vi.mock("@/server/redis/probe", () => ({
  isRedisConfigured: () => true,
  probeRedis: async () => undefined,
}));

vi.mock("@/server/search/probe", () => ({
  isMeilisearchConfigured: () => true,
  probeMeilisearch: async () => undefined,
}));

vi.mock("@/server/storage/probe", () => ({
  isR2Configured: () => true,
  probeR2: async () => undefined,
}));

vi.mock("@/server/email/probe", () => ({
  isResendConfigured: () => true,
  probeResend: async () => undefined,
}));

vi.mock("@/server/observability/probe", () => ({
  isSentryConfigured: () => true,
  probeSentry: async () => undefined,
}));

vi.mock("@/server/auth/mfa/mfa-encryption-probe", () => ({
  isMfaEncryptionConfigured: () => true,
  probeMfaEncryption: async () => undefined,
}));

vi.mock("@/server/async/probe", () => ({
  isAsyncWorkersConfigured: () => true,
  probeAsyncWorkerLiveness: async () => undefined,
}));

const ENTRY = "database identity";

const MATCHING = [{ db: "lombakita_staging", usr: "lombakita_app" }];

const entryNamed = (payload: ConnectorStatusPayload, name: string) =>
  payload.connectors.find((item) => item.name === name);

const names = (payload: ConnectorStatusPayload) => payload.connectors.map((item) => item.name);

const statusWith = (options: {
  includeLiveChecks: boolean;
  declaredEnvironment?: DeployEnvironment;
}) =>
  getConnectorStatusPayload({
    includeWorkerLiveness: false,
    ...options,
  });

beforeEach(() => {
  server.rows = MATCHING;
});

describe("getConnectorStatusPayload — the database identity check", () => {
  it("reports up when the server answers as the declared environment's database and runtime role", async () => {
    const payload = await statusWith({ includeLiveChecks: true, declaredEnvironment: "preview" });

    expect(entryNamed(payload, ENTRY)).toEqual({ name: ENTRY, configured: true, live: "up" });
  });

  it("reports down on a role mismatch, naming the role", async () => {
    server.rows = [{ db: "lombakita_staging", usr: "lombakita_migrate" }];

    const payload = await statusWith({ includeLiveChecks: true, declaredEnvironment: "preview" });

    expect(entryNamed(payload, ENTRY)).toEqual({
      name: ENTRY,
      configured: true,
      live: "down",
      detail: 'role: observed "lombakita_migrate", expected "lombakita_app"',
    });
  });

  it("reports down on a database mismatch, naming the database", async () => {
    server.rows = [{ db: "lombakita_production", usr: "lombakita_app" }];

    const payload = await statusWith({ includeLiveChecks: true, declaredEnvironment: "preview" });

    expect(entryNamed(payload, ENTRY)?.detail).toBe(
      'database: observed "lombakita_production", expected "lombakita_staging"',
    );
  });

  // A DOWN ENTRY IS A FAILED RUN, and this is the half of that which lives here: the deploy gate
  // reads `configured && live === "down"` off these entries. An entry named `database identity`
  // reporting down is therefore a refusal to deploy, not a note.
  it("counts a refusal in the summary the gate reads", async () => {
    server.rows = [{ db: "lombakita_staging", usr: "lombakita_migrate" }];

    const payload = await statusWith({ includeLiveChecks: true, declaredEnvironment: "preview" });

    expect(payload.summary.liveDown).toBe(1);
    expect(payload.connectors.some((item) => item.configured && item.live === "down")).toBe(true);
  });

  it("adds its entry after the postgres probe it belongs to", async () => {
    const payload = await statusWith({ includeLiveChecks: true, declaredEnvironment: "preview" });

    expect(names(payload).indexOf(ENTRY)).toBeGreaterThan(names(payload).indexOf("postgres"));
  });

  // THE GUARD THAT KEEPS THIS FROM BEING FAIL-OPEN. The expectation is the CALLER's declaration, so
  // a caller that declared nothing has none to assert against and the check must not run — not run
  // against an environment inferred from somewhere else, which is how a check keyed on APP_ENV
  // silently never fires.
  it("does not run when no environment was declared", async () => {
    const payload = await statusWith({ includeLiveChecks: true });

    expect(names(payload)).not.toContain(ENTRY);
  });

  it("does not run when live checks are off, even with an environment declared", async () => {
    const payload = await statusWith({ includeLiveChecks: false, declaredEnvironment: "preview" });

    expect(names(payload)).not.toContain(ENTRY);
  });

  // The payload a configuration-only run prints is the payload it printed before this check existed:
  // same nine entries, in the same order, with the same summary.
  it("leaves the payload otherwise untouched when it does not run", async () => {
    const payload = await statusWith({ includeLiveChecks: false, declaredEnvironment: "preview" });

    expect(names(payload)).toEqual([
      "postgres",
      "migration-database",
      "redis",
      "meilisearch",
      "r2",
      "resend",
      "sentry",
      "mfa-encryption",
      "worker",
    ]);
    expect(payload.summary).toEqual({ configured: 9, liveUp: 0, liveDown: 0 });
  });
});

describe("buildHealthPayload", () => {
  // /api/health declares no environment and must keep declaring none: it is a request-serving
  // endpoint, and a deploy gate's assertion has no business running behind it.
  it("produces no database identity entry, because /api/health declares no environment", async () => {
    const { buildHealthPayload } = await import("@/server/health");

    const payload = await buildHealthPayload({ includeLiveChecks: true });

    expect(payload.connectors.connectors.map((item) => item.name)).not.toContain(ENTRY);
    expect(payload.connectors.summary.liveUp).toBeGreaterThan(0);
  });
});
