import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/cancel-affordance");

import { getDb, type Database } from "@/server/db/client";
import { findTeamPaymentGroupAnchor, hasSubmittedPaymentProof } from "./paid-registration";

// WHETHER THE CANCEL AFFORDANCE MAY BE OFFERED, for both registration modes at once (DEC-0131).
//
// Extracted from the registration page rather than written inline there for two reasons. The page
// is an async server component with an auth redirect, so logic living in it cannot be driven by a
// test; and the individual and team answers are two booleans of the same type computed side by
// side, which is precisely the shape that survives being swapped. Both are asserted here against a
// real database.
//
// This resolves the DISPLAY question through the same predicate the two cancel SERVICES call. A
// second, lighter derivation written at the page is how a control ends up offered on a registration
// the server refuses to cancel — the failure this surface exists to prevent.

export type CancelAffordanceInput = {
  /** The calling candidate's own individual registration, when they hold one. */
  individualRegistration: { id: string; status: string } | null;
  /** The team they belong to for this competition, when they belong to one. */
  team: { id: string; status: string } | null;
};

export type CancelAffordanceState = {
  /** True when the individual cancel control must be WITHHELD. */
  individualCancellationClosed: boolean;
  /** True when the team cancel control must be WITHHELD. */
  teamCancellationClosed: boolean;
};

/**
 * Resolves both withholding decisions.
 *
 * Each is asked only where a control would otherwise render: a registration that is already
 * cancelled, or a team still forming, has no cancel affordance to withhold, and asking anyway would
 * spend two queries to answer a question nothing reads.
 *
 * The team answer is anchored on ANY member's registration row, never the captain's specifically. A
 * team pays once and every member's row shares that payment, so this is a fact about the team.
 */
export const resolveCancelAffordanceState = async (
  input: CancelAffordanceInput,
  db: Database = getDb(),
): Promise<CancelAffordanceState> => {
  const individualCancellationClosed =
    input.individualRegistration !== null && input.individualRegistration.status === "confirmed"
      ? await hasSubmittedPaymentProof(input.individualRegistration.id, db)
      : false;

  const teamAnchorRegistrationId =
    input.team !== null && input.team.status === "submitted"
      ? await findTeamPaymentGroupAnchor(input.team.id, db)
      : null;

  const teamCancellationClosed =
    teamAnchorRegistrationId === null
      ? false
      : await hasSubmittedPaymentProof(teamAnchorRegistrationId, db);

  return { individualCancellationClosed, teamCancellationClosed };
};
