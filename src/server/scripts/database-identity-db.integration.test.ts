// @vitest-environment node
//
// `readServerIdentity` against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE, and why the unit suite cannot. `database-identity.test.ts` drives
// the reader against a stub, so it measures the function and nothing about the connection: a reader
// that returned a constant, or read the name out of the connection string it was handed, would pass
// every one of those tests. Here the client is real and the expectation is derived from the URL, so
// the only way to satisfy it is for the SERVER to answer (Rule 33).
//
// The connection string's own path is used as the expectation deliberately, and it is not the
// mechanism DEC-0207 distrusts: nothing here is checking a deployment, it is checking that the
// reader and the server agree about the connection the reader was actually given.

import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { readServerIdentity } from "@/server/scripts/database-identity";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const client = TEST_DATABASE_URL
  ? postgres(TEST_DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 15, prepare: false })
  : null;

afterAll(async () => {
  await client?.end({ timeout: 5 });
});

describe.skipIf(skipWithoutDatabase)("readServerIdentity against a real database", () => {
  it("returns the name the SERVER is answering from", async () => {
    if (!client || !TEST_DATABASE_URL) throw new Error("no database");

    const expectedDatabase = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
    const expectedRole = decodeURIComponent(new URL(TEST_DATABASE_URL).username);

    const identity = await readServerIdentity(client);

    expect(identity.database).toBe(expectedDatabase);
    expect(identity.role).toBe(expectedRole);
  });

  // A ROW IS NOT AN IDENTITY. The shape the reader hands a caller is exactly two strings, so a
  // caller comparing them cannot be comparing `undefined` and reporting a mismatch it invented.
  it("hands back two non-empty strings and nothing else", async () => {
    if (!client) throw new Error("no database");

    const identity = await readServerIdentity(client);

    expect(Object.keys(identity).sort()).toEqual(["database", "role"]);
    expect(typeof identity.database).toBe("string");
    expect(typeof identity.role).toBe("string");
    expect(identity.database.length).toBeGreaterThan(0);
    expect(identity.role.length).toBeGreaterThan(0);
  });
});
