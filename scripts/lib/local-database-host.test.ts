import { describe, expect, it } from "vitest";
import { isLocalDatabaseHost, parseDatabaseHost } from "./local-database-host";

describe("isLocalDatabaseHost", () => {
  it("matches an IPv6 loopback host written as a bracketed literal", () => {
    // The regression this file exists for. `new URL(...).hostname` yields "[::1]" WITH brackets, so
    // a check comparing against the bare "::1" never matches. It failed closed (a local IPv6
    // database was refused as remote) which is why it survived unnoticed rather than causing an
    // incident. An untested fix is how it returns.
    expect(parseDatabaseHost("postgresql://[::1]:5432/lombakita")).toBe("[::1]");
    expect(isLocalDatabaseHost("postgresql://[::1]:5432/lombakita")).toBe(true);
  });

  it("matches the other loopback spellings", () => {
    expect(isLocalDatabaseHost("postgresql://localhost:5432/lombakita")).toBe(true);
    expect(isLocalDatabaseHost("postgresql://127.0.0.1:5432/lombakita")).toBe(true);
  });

  it("matches a loopback host carrying credentials and query parameters", () => {
    expect(isLocalDatabaseHost("postgresql://app:secret@localhost:5432/db?sslmode=disable")).toBe(
      true,
    );
  });

  it("refuses a deployed host", () => {
    expect(isLocalDatabaseHost("postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/db")).toBe(false);
  });

  it("refuses a host that merely contains a loopback spelling", () => {
    // Substring matching would accept both of these. The check is an equality test on the parsed
    // hostname for exactly this reason.
    expect(isLocalDatabaseHost("postgres://u:p@localhost.attacker.example/db")).toBe(false);
    expect(isLocalDatabaseHost("postgres://u:p@not-localhost/db")).toBe(false);
  });

  it("reports an unparseable connection string as non-local", () => {
    // Fail closed: a caller uses this to decide whether it may write to financial tables, and a
    // string that cannot be read is not one to write through.
    expect(parseDatabaseHost("not a url")).toBeNull();
    expect(isLocalDatabaseHost("not a url")).toBe(false);
    expect(isLocalDatabaseHost("")).toBe(false);
  });
});
