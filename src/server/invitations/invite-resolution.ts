import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/invitations/invite-resolution");

import { createHash } from "crypto";
import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutionInvitations, teamInvitations, users } from "@/server/db/schema";

// Step 6.5e — shared invite-recipient resolution for BOTH invitation systems (institution
// membership + team). Extends the Step 6.5.1 invite-time email→user resolution (DEC-0082) to also
// accept a username, and to handle the no-account case with the `pending_claim` lifecycle.
//
// This is the single resolver — neither service builds its own. The two invitation services parse
// the raw identifier into the discriminated `InviteIdentifier` (mapping a malformed value to their
// own typed error) and then call `resolveInviteRecipient`.

// Email shape mirrors institution-invitations/invitation-core.ts and teams/team-core.ts so the
// regex behaviour stays consistent across the platform.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Username charset is locked by platform-domain-contract.yaml `username_handle.validation` and
// `parseUsername` in profile-core.ts: lowercase alphanumerics + underscore, 3–30 chars. We match
// case-insensitively (usernames are stored lowercase), so we lowercase the input before testing.
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

export type InviteIdentifier =
  | { kind: "email"; value: string }
  | { kind: "username"; value: string };

// Classify a raw invite identifier as an email or a username, or reject it. The "@" is the
// discriminant — a username can never contain one (underscore charset), and an email always does.
export const classifyInviteIdentifier = (raw: unknown): InviteIdentifier | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.includes("@")) {
    if (!EMAIL_PATTERN.test(trimmed)) return null;
    return { kind: "email", value: trimmed.toLowerCase() };
  }

  const lowered = trimmed.toLowerCase();
  if (!USERNAME_PATTERN.test(lowered)) return null;
  return { kind: "username", value: lowered };
};

export type InviteResolution =
  // An existing account owns this invite: it surfaces in their inbox immediately as `pending`.
  // `invitedEmail` is the account's own (lowercased) email — kept on the row so claim-at-signup,
  // the dedup guards, and the audit trail all key on a stable address.
  | { mode: "targeted"; targetUserId: string; invitedEmail: string }
  // An email with no verified account yet: store the lowercased email, leave the target null, the
  // row sits `pending_claim` until claim-at-signup attaches it.
  | { mode: "pending_claim"; invitedEmail: string }
  // A username that resolves to no account. A username cannot become a `pending_claim` (there is no
  // email to claim against later), so the caller surfaces a typed "recipient not found" error.
  | { mode: "username_not_found" };

// Resolve an identifier to a recipient outcome. Reads only — safe to call outside a transaction.
//
//   email → existing VERIFIED account  : targeted (live in their inbox)
//   email → no verified account        : pending_claim (claimed when the email registers + verifies)
//   username → existing account        : targeted
//   username → no account              : username_not_found
//
// "Verified" for the email path means `users.emailVerified IS NOT NULL` (Auth.js account-email
// confirmation). An existing-but-unverified account is treated as no-account-yet for inbox purposes:
// the invite stays `pending_claim` and is claimed when that account completes verification.
export const resolveInviteRecipient = async (
  identifier: InviteIdentifier,
  db: Database = getDb(),
): Promise<InviteResolution> => {
  if (identifier.kind === "email") {
    const [verifiedAccount] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, identifier.value), isNotNull(users.emailVerified)))
      .limit(1);

    if (verifiedAccount) {
      return { mode: "targeted", targetUserId: verifiedAccount.id, invitedEmail: identifier.value };
    }

    return { mode: "pending_claim", invitedEmail: identifier.value };
  }

  // username
  const [account] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.username, identifier.value))
    .limit(1);

  if (!account) {
    return { mode: "username_not_found" };
  }

  return {
    mode: "targeted",
    targetUserId: account.id,
    invitedEmail: account.email.toLowerCase(),
  };
};

// Step 6.5e — claim-link reconciliation (item 3). The claim email links to
// `/auth/login?invite=<rawToken>` (DIRECT, so the DEC-0084 /auth/register→/auth/login redirect
// cannot drop the param). The login page calls this to resolve the token to the invited email and
// prefill the signup field, so the new account is created with the address claim-at-signup matches.
//
// Scope is deliberately limited to `pending_claim` invites (no account yet, target null, not
// expired): a token never reveals an EXISTING user's email (a `pending` row), and acceptance is not
// token-driven — the token grants nothing beyond this prefill. Looks in both invitation systems.
export const resolveClaimInviteEmailByToken = async (
  rawToken: string,
  db: Database = getDb(),
): Promise<string | null> => {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  const [institutionRow] = await db
    .select({ invitedEmail: institutionInvitations.invitedEmail })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.tokenHash, tokenHash),
        eq(institutionInvitations.status, "pending_claim"),
        isNull(institutionInvitations.targetUserId),
        gt(institutionInvitations.expiresAt, now),
      ),
    )
    .limit(1);

  if (institutionRow) return institutionRow.invitedEmail;

  const [teamRow] = await db
    .select({ invitedEmail: teamInvitations.invitedEmail })
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.tokenHash, tokenHash),
        eq(teamInvitations.status, "pending_claim"),
        isNull(teamInvitations.targetUserId),
        gt(teamInvitations.expiresAt, now),
      ),
    )
    .limit(1);

  return teamRow?.invitedEmail ?? null;
};
