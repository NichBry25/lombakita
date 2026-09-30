/**
 * The server's own answer to "which database, and which role, are we talking to".
 *
 * IN BAND, ON PURPOSE (DEC-0207). A connection string's path segment and user are the claim under
 * test, not the evidence: Railway production carried a `MIGRATION_DATABASE_URL` whose host and name
 * both said staging, and every check in the repository agreed with it because none of them asked the
 * server. `current_database()` and `current_user` are answered by the process on the other end of
 * the socket, so the string cannot talk its way past them.
 *
 * ONE READER, THREE LANES. The migration entry point, the schema-drift check and the deploy gate's
 * runtime identity check all ask this question. It lives here once so a lane cannot drift into
 * asking a differently worded one, and so there is a single place to look when the answer is
 * surprising.
 *
 * The connection is STRUCTURALLY TYPED (`IdentifiableConnection`, the shape `reset-guard.ts` already
 * exports for exactly this reason) rather than postgres.js's `Sql`, so the read is exercisable
 * against a stub without a database. Nothing in this file has a side effect.
 */

import type { IdentifiableConnection } from "../../../scripts/reset/reset-guard";

export type ServerIdentity = {
  database: string;
  role: string;
};

/**
 * Reads the identity, and refuses to answer if the server did not name itself.
 *
 * AN EMPTY OR MALFORMED ANSWER IS NOT "NO OBJECTION". A server that returned nothing, or returned a
 * row whose fields are not strings, has not been identified — and an unidentified server is the one
 * case a caller of this must never proceed on. The message is one callers can surface verbatim.
 */
export const readServerIdentity = async (sql: IdentifiableConnection): Promise<ServerIdentity> => {
  const rows = await sql.unsafe("select current_database() as db, current_user as usr");
  const row = rows[0];

  if (!row || typeof row.db !== "string" || typeof row.usr !== "string") {
    throw new Error("Connected but the server returned no identity row.");
  }

  return { database: row.db, role: row.usr };
};

/**
 * Names every field where the server's answer differs from what was expected, or null on a match.
 *
 * Both fields are compared against a value the caller DECLARED, never against anything read out of
 * the connection string, so the two sides of the comparison have independent origins.
 *
 * Pure, no I/O, and it takes the expectations as optional fields so a caller checking one of them
 * cannot accidentally assert the other against `undefined`.
 */
export const identityMismatch = (
  observed: ServerIdentity,
  expected: { database?: string; role?: string },
): string | null => {
  const mismatches: string[] = [];

  if (expected.database !== undefined && observed.database !== expected.database) {
    mismatches.push(`database: observed "${observed.database}", expected "${expected.database}"`);
  }

  if (expected.role !== undefined && observed.role !== expected.role) {
    mismatches.push(`role: observed "${observed.role}", expected "${expected.role}"`);
  }

  return mismatches.length > 0 ? mismatches.join("; ") : null;
};
