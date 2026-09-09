/**
 * The single TLS policy every Postgres client in this repository connects under.
 *
 * It exists as its own module rather than an export of `client.ts` because `client.ts` asserts the
 * `web` runtime at import time. The migration probe and the drift check are CLI programs, so they
 * cannot import it without failing that assertion, and before this module existed they each carried
 * their own `ssl: "require"` literal instead.
 *
 * `ssl: "require"` is not the tightening it reads as. postgres.js treats the strings `require`,
 * `allow` and `prefer` as "encrypt but do not check who you are talking to": it sets
 * `rejectUnauthorized = false` for all three, so a literal `require` encrypts the session while
 * accepting any certificate presented.
 *
 * WHAT ONE POLICY BUYS, PRECISELY. Every client answers to `DB_SSL_MODE` instead of to a literal
 * of its own. It does NOT follow that they verify their peer: the default mode is `inherit`, under
 * which this returns `undefined` and the connection string's own `sslmode` governs, and a Neon URL
 * carries `sslmode=require`, which is the unverified case above. Verification happens only where
 * `DB_SSL_MODE` is provisioned with a verifying value in the environment that runs these programs.
 */

import type postgres from "postgres";
import { serverEnv } from "@/config/env.server";

export type DatabaseSslOption = postgres.Options<Record<string, never>>["ssl"];

/**
 * Returns `undefined` under the default `inherit` mode, which omits the option and lets the
 * connection string's own `sslmode` govern. That is deliberate: it is what makes one policy work
 * across Neon, a local socket and a CI container without a mode per environment.
 */
export const resolveDatabaseSslOption = (): DatabaseSslOption | undefined => {
  if (serverEnv.databaseSslMode === "inherit") {
    return undefined;
  }

  if (serverEnv.databaseSslMode === "disable") {
    return false;
  }

  const tlsOptions: {
    rejectUnauthorized: boolean;
    ca?: string;
  } = {
    rejectUnauthorized:
      serverEnv.databaseSslMode === "require_insecure"
        ? false
        : serverEnv.databaseSslRejectUnauthorized,
  };

  if (serverEnv.databaseSslCaCertBase64) {
    tlsOptions.ca = Buffer.from(serverEnv.databaseSslCaCertBase64, "base64").toString("utf8");
  }

  return tlsOptions;
};
