import { vi } from "vitest";

// Unit-test stubs shared by the platform-ops writers that resolve their acting account from the
// database. A writer reads the actor first, then its target, so a test serves reads in CALL ORDER:
// a writer that reads the target before the actor reads the actor's row as the target.

export type SelectRows = Array<Record<string, unknown>>;

/**
 * A transaction `select()` serving one result per call, in call order. Every builder step returns
 * the chain and `limit` resolves the rows, so joins and plain selects both work.
 */
export const makeSequencedSelect = (reads: SelectRows[]) => {
  let call = 0;
  return vi.fn(() => {
    const rows = reads[call++] ?? [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "innerJoin", "leftJoin", "where"]) {
      chain[step] = vi.fn(() => chain);
    }
    chain.limit = vi.fn().mockResolvedValue(rows);
    return chain;
  });
};

export const operatorActorRow = (id: string, role = "platform_ops"): SelectRows[number] => ({
  id,
  role,
  suspendedAt: null,
});

// The three refusals of resolveOperatorActor, as the rows that produce them.
export const invalidOperatorActorCases = (id: string, requiredRole = "platform_ops") => [
  { label: "missing", row: null, code: "operator_actor_not_found" },
  {
    label: "wrong-role",
    row: operatorActorRow(id, requiredRole === "platform_ops" ? "candidate" : "platform_ops"),
    code: "operator_actor_not_platform_ops",
  },
  {
    label: "suspended",
    row: { id, role: requiredRole, suspendedAt: new Date() },
    code: "operator_actor_suspended",
  },
];

// assertOperatorHasNoInstitutionRelationship issues four reads in a fixed order: membership, filed
// submission, the actor's email, invitation.
export const NO_INSTITUTION_RELATIONSHIP_READS: SelectRows[] = [
  [],
  [],
  [{ email: "operator@example.test" }],
  [],
];

export const MEMBERSHIP_RELATIONSHIP_READS: SelectRows[] = [[{ id: "membership_1" }]];
export const FILED_SUBMISSION_RELATIONSHIP_READS: SelectRows[] = [[], [{ id: "submission_1" }]];
export const INVITATION_BY_ID_RELATIONSHIP_READS: SelectRows[] = [
  [],
  [],
  [{ email: "operator@example.test" }],
  [{ id: "invitation_1" }],
];

// The relationship arms a conflicted operator can hit. An invitation by id and an invitation by
// email resolve to the same row read; the email arm is distinguished only by what the real helper
// matches on, which the real-database tests exercise.
export const CONFLICTED_RELATIONSHIP_CASES = [
  { arm: "membership", reads: MEMBERSHIP_RELATIONSHIP_READS },
  { arm: "filed submission", reads: FILED_SUBMISSION_RELATIONSHIP_READS },
  { arm: "invitation", reads: INVITATION_BY_ID_RELATIONSHIP_READS },
];
