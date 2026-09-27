// @vitest-environment node
//
// `createSqlClient` is where every Postgres connection in this repository is built from a string, and
// its URL argument is what lets a probe measure the credential IT read rather than the one the app
// serves from. Both halves of that are asserted here against a mocked `postgres`, so no socket is
// opened: the no-argument call takes `serverEnv.databaseUrl`, and a call WITH an argument takes that
// argument and nothing else.
//
// The two halves fail independently on purpose. A no-argument test alone passes over a factory that
// ignores its parameter — which is the whole point of the parameter, and would leave the identity
// probe connecting to the app's database while asserting about a different one.

import { afterEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => [] as Array<{ url: string }>);

vi.mock("postgres", () => ({
  default: (url: string) => {
    clients.push({ url });
    return { end: async () => {} };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  clients.length = 0;
});

describe("createSqlClient", () => {
  it("uses requireDatabaseUrl()'s value when called with no argument", async () => {
    // `serverEnv` snapshots `process.env` at module load, so the variable is stubbed before the
    // module graph is imported rather than around the call.
    vi.stubEnv("DATABASE_URL", "postgres://app_role@127.0.0.1:5432/served_db");

    const { createSqlClient } = await import("@/server/db/client");
    const { serverEnv } = await import("@/config/env.server");

    createSqlClient();

    expect(serverEnv.databaseUrl).toBe("postgres://app_role@127.0.0.1:5432/served_db");
    expect(clients.at(-1)?.url).toBe(serverEnv.databaseUrl);
  });

  // THE ARGUMENT IS THE POINT OF THE PARAMETER. With `DATABASE_URL` left unset, a factory that
  // ignored its argument could not fall back to the configured value — it would have to throw.
  it("uses the URL it is given rather than the configured one", async () => {
    const { createSqlClient } = await import("@/server/db/client");

    createSqlClient("postgres://probe_role@127.0.0.1:5432/claimed_db");

    expect(clients.at(-1)?.url).toBe("postgres://probe_role@127.0.0.1:5432/claimed_db");
  });
});
