import { sql } from "drizzle-orm";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/mfa-factor-sql");

/**
 * Correlated EXISTS answering "does this account hold a VERIFIED MFA factor", for use in any query
 * whose FROM/JOIN set includes `users`. It exists as a named constant, rather than inline at its one
 * call site, so it can be executed against a real database by a test — the defect below is invisible
 * to every mocked one.
 *
 * Same shape AND same constraint as `institutionOwnerUsernameSql`: the correlation MUST name the
 * outer table as the LITERAL TEXT `users.id`. Interpolating the Drizzle column (`${users.id}`)
 * renders a bare `"id"`, and inside this subquery a bare `"id"` binds to `mfa_factors.id` — so the
 * predicate silently becomes `mfa_factors.user_id = mfa_factors.id`, matches nothing, and reports
 * every account as un-enrolled. Postgres raises no error: both names resolve, just to the wrong
 * table. The inner alias `mf` keeps the two sides visibly distinct.
 */
export const hasVerifiedMfaFactorSql = sql<boolean>`EXISTS (
  SELECT 1 FROM mfa_factors mf
  WHERE mf.user_id = users.id AND mf.verified_at IS NOT NULL
)`;
