/*
 * Rule 36 probes for the password-recovery guards (LAUNCH-D192).
 *
 * Eight guards, each probed in the directions that exist for it. A guard that only passes its removal
 * probe can still sit below the work it is meant to prevent, and a pure read has no move analogue, so
 * one is stated rather than fabricated.
 *
 *   (1) the per-ADDRESS bound on the request route is counted BEFORE the account lookup
 *       — class C (route gate). Removal and move. The detector is that the lookup service is NOT
 *       CALLED, never the 429 alone: a gate that answers 429 after the lookup has run still answers
 *       429, and the lookup is the existence oracle the bound is written to keep closed.
 *   (2) the per-IP bound on the request route — class C. Removal and move, same detector.
 *   (3) the reset confirm judges the token BEFORE it hashes the new password
 *       — class B. The token refusals throw before any transaction opens, and what they protect is
 *       a scrypt hash, which writes nothing, so the post-state is whether the hash was ever
 *       requested. The detector is the spy on `hashPassword`. The harmful move is the hash running
 *       above the refusals, which makes a guessed or replayed token cost the server a scrypt each.
 *   (4) `isSessionRevoked` revokes — class D (read-only; the detector is the result content). A pure
 *       predicate has no move analogue, so there is a removal probe and no move probe. A second
 *       removal probe covers the session callback acting on the predicate, because a correct
 *       predicate nobody consults revokes nothing.
 *   (5) the change route checks its failed-attempt limiter BEFORE `verifyPassword`
 *       — class B (the guard returns before any write, in a function with a transaction below it).
 *       Removal and move. The detector is the spy on `verifyPassword`: a limited account must do no
 *       scrypt work.
 *   (6) the confirm transaction's conditional consume refuses a token consumed between the read and
 *       the update — class A1-in (throws inside a transaction; rollback restores the post-state,
 *       so the detector is refusal identity). Removal only: moving the throw within the callback is
 *       benign, because the rollback undoes whatever ran above it. Two removal probes cover it: the
 *       throw itself, and the `consumed_at IS NULL` predicate that makes the UPDATE touch no row.
 *       The predicate is what the real-database stale-read test pins; with it gone the throw can
 *       never fire, and a stub that answers the UPDATE by hand cannot tell.
 *   (7) the `signedInAtMs` claim is minted only at sign-in — class D (read-only; the detector is the
 *       result content). The harmful move is minting it on every jwt call, which re-dates a refreshed
 *       token past the stamp so a password change revokes nothing. Removing the mint outright is
 *       already caught by the sign-in claim test and is not probed again here.
 *   (8) the change route judges the current password's length BEFORE `verifyPassword`
 *       — class B (throws before any write, in a function with a transaction below it). The harmful
 *       move is the length check running after the verify, which sends an over-length password to
 *       scrypt and, on a mismatch, counts it as a failed attempt. The detector is the spy on
 *       `verifyPassword` in the 73-character case. Two probes: 13 moves the check below the verify
 *       and 14 removes it, and the same over-maximum test goes red for both.
 *
 * Each detector names the one case it claims to break. The route cases seed ONE counter past its
 * ceiling and leave the other alone, so neutering one bound cannot be masked by the other refusing.
 *
 * Usage: node scripts/testing/probes/password-recovery.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const REQUEST_ROUTE = "src/app/api/v1/auth/password-reset/request/route.ts";
const SERVICE = "src/server/auth/password-reset.ts";
const REVOCATION = "src/server/auth/session-revocation.ts";
const AUTH_CONFIG = "src/server/auth/auth.config.ts";

const ROUTE_TEST = "src/app/api/v1/auth/password-recovery.test.ts";
const SERVICE_TEST = "src/server/auth/password-reset.integration.test.ts";
const SINGLE_USE_TEST = "src/server/auth/password-reset-single-use.test.ts";
const REVOCATION_TESTS = [
  "src/server/auth/session-revocation.test.ts",
  "src/server/auth/auth-config-session-revocation.test.ts",
];

const REACHED_IP = /× .*refuses on the IP bound without looking the address up/;
const REACHED_ADDRESS = /× .*refuses on the address bound without looking the address up/;
const REACHED_NO_HASH_FOR_UNKNOWN = /× .*does no hashing work for a token that does not exist/;
const REACHED_PREDICATE = /× .*revokes a token signed in before the stamp/;
const REACHED_CALLBACK = /× .*returns an empty object for a token signed in before the stamp/;
const REACHED_SINGLE_USE =
  /× .*refuses, and writes nothing else, when the token was consumed between the read and the update/;
const REACHED_LIMITER_FIRST = /× .*checks the limiter before it verifies the current password/;
const REACHED_STALE_READ =
  /× .*refuses, and changes nothing, when the token was consumed between the read and the update/;
const REACHED_CLAIM_KEPT = /× .*keeps the sign-in instant across a refresh/;
const REACHED_LENGTH_FIRST = /× .*refuses 73 characters without verifying/;

const IP_REFUSAL = `  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }`;

const ADDRESS_REFUSAL = `    if (!addressRate.allowed) {
      return rateLimitedResponse(addressRate.retryAfterSeconds);
    }`;

const LOOKUP_CALL = "    const outcome = await requestPasswordReset(email);";

/**
 * Moves a refusal below the lookup it exists to prevent, which is the harmful move for a class C
 * gate. Deleted from its own position first, so the probe cannot pass on a route that merely gained
 * a second copy of the check while keeping the original above the lookup.
 */
const moveRefusalBelow = (file, refusal, call) => {
  substituteOnce(file, `${refusal}\n`, "");
  substituteOnce(file, call, `${call}\n${refusal}`);
};

const HASH_LINES = `  const validPassword = parsePassword(password);
  const passwordHash = await hashPassword(validPassword);
`;
const TOKEN_REFUSAL_HEAD = "  if (!tokenRecord || tokenRecord.consumedAt) {";

const LIMITED_REFUSAL = `  if (attempts.limited) {
    return { outcome: "rate_limited", retryAfterSeconds: attempts.retryAfterSeconds };
  }
`;
const CONSUME_REFUSAL_CONDITION = "    if (consumed.length === 0) {";
const CONSUME_UNCONSUMED_PREDICATE = `          eq(userPasswordResetTokens.id, tokenRecord.id),
          isNull(userPasswordResetTokens.consumedAt),
`;
const SIGN_IN_CLAIM_MINT = `        delete token.mfaVerifiedAt;
        token.signedInAtMs = Date.now();
      }
`;
const VERIFY_CALL = `  const currentMatches = await verifyPassword(
    parseCurrentPassword(currentPassword),
    account.passwordHash,
  );`;

const routeDetector = (reached) => async () => fails("npx", ["vitest", "run", ROUTE_TEST], reached);

export const probes = [
  {
    name: "request: the IP bound is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running but never refusing, so the reset endpoint stays unbounded while " +
      "appearing to be rate limited",
    files: [REQUEST_ROUTE],
    appliedMarkers: ["if (ipRate.allowed && !ipRate.allowed)"],
    mutate: () =>
      substituteOnce(
        REQUEST_ROUTE,
        "if (!ipRate.allowed) {",
        "if (ipRate.allowed && !ipRate.allowed) {",
      ),
    detect: routeDetector(REACHED_IP),
  },
  {
    name: "request: the IP bound refuses BEFORE the address is looked up",
    klass: "C",
    harmfulMove:
      "the refusal sitting below requestPasswordReset, so an over-limit caller still issues a " +
      "token and schedules a send, and is merely told it was refused",
    files: [REQUEST_ROUTE],
    appliedMarkers: [`${LOOKUP_CALL}\n${IP_REFUSAL}`],
    mutate: () => moveRefusalBelow(REQUEST_ROUTE, IP_REFUSAL, LOOKUP_CALL),
    detect: routeDetector(REACHED_IP),
  },
  {
    name: "request: the address bound is what refuses",
    klass: "C",
    harmfulMove:
      "the per-address bound running but never refusing, so a caller rotating IPs can have the " +
      "platform mail one person without limit",
    files: [REQUEST_ROUTE],
    appliedMarkers: ["if (addressRate.allowed && !addressRate.allowed)"],
    mutate: () =>
      substituteOnce(
        REQUEST_ROUTE,
        "if (!addressRate.allowed) {",
        "if (addressRate.allowed && !addressRate.allowed) {",
      ),
    detect: routeDetector(REACHED_ADDRESS),
  },
  {
    name: "request: the address bound is counted BEFORE the address is looked up",
    klass: "C",
    harmfulMove:
      "the address refusal sitting below requestPasswordReset, so the cap is reached only after " +
      "the lookup has run and the 429 becomes an account-existence oracle",
    files: [REQUEST_ROUTE],
    appliedMarkers: [`${LOOKUP_CALL}\n${ADDRESS_REFUSAL}`],
    mutate: () => moveRefusalBelow(REQUEST_ROUTE, ADDRESS_REFUSAL, LOOKUP_CALL),
    detect: routeDetector(REACHED_ADDRESS),
  },
  {
    name: "confirm: the token is judged BEFORE the new password is hashed",
    klass: "B",
    harmfulMove:
      "hashPassword running above the token refusals, so a guessed, consumed or expired token " +
      "costs the server a scrypt hash per request",
    files: [SERVICE],
    appliedMarkers: [`hashPassword(validPassword);\n\n${TOKEN_REFUSAL_HEAD}`],
    mutate: () => {
      substituteOnce(SERVICE, `${HASH_LINES}\n`, "");
      substituteOnce(SERVICE, TOKEN_REFUSAL_HEAD, `${HASH_LINES}\n${TOKEN_REFUSAL_HEAD}`);
    },
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_NO_HASH_FOR_UNKNOWN),
  },
  {
    name: "isSessionRevoked: the comparison is what revokes",
    klass: "D",
    harmfulMove:
      "the predicate answering false for a token signed in before the stamp, so a password change " +
      "signs nobody out. Read-only: there is no move analogue for a pure predicate",
    files: [REVOCATION],
    appliedMarkers: ["  return false;\n};"],
    mutate: () =>
      substituteOnce(
        REVOCATION,
        "  return tokenSignedInAtMs < params.sessionsInvalidBefore.getTime();",
        "  return false;",
      ),
    detect: async () => fails("npx", ["vitest", "run", ...REVOCATION_TESTS], REACHED_PREDICATE),
  },
  {
    name: "session callback: a revoked token's session is emptied",
    klass: "D",
    harmfulMove:
      "the session callback computing the predicate and then returning the session unchanged, so " +
      "a correct predicate that nothing acts on revokes nothing",
    files: [AUTH_CONFIG],
    appliedMarkers: ["        void session;\n        return session;"],
    mutate: () =>
      substituteOnce(
        AUTH_CONFIG,
        "        return {} as Session;",
        "        void session;\n        return session;",
      ),
    detect: async () => fails("npx", ["vitest", "run", ...REVOCATION_TESTS], REACHED_CALLBACK),
  },
  {
    name: "change: the failed-attempt limiter is what refuses",
    klass: "B",
    harmfulMove:
      "the limiter being read but never refusing, so a stolen session can keep guessing the " +
      "current password",
    files: [SERVICE],
    appliedMarkers: ["if (attempts.limited && !attempts.limited)"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        "if (attempts.limited) {",
        "if (attempts.limited && !attempts.limited) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_LIMITER_FIRST),
  },
  {
    name: "change: the failed-attempt limiter refuses BEFORE the current password is verified",
    klass: "B",
    harmfulMove:
      "the limiter refusal sitting below verifyPassword, so a limited account still does a scrypt " +
      "per guess and a correct guess is still checked while it is meant to be locked out",
    files: [SERVICE],
    appliedMarkers: [`${VERIFY_CALL}\n\n${LIMITED_REFUSAL.trimEnd()}`],
    mutate: () => {
      substituteOnce(SERVICE, `${LIMITED_REFUSAL}\n`, "");
      substituteOnce(SERVICE, VERIFY_CALL, `${VERIFY_CALL}\n\n${LIMITED_REFUSAL.trimEnd()}`);
    },
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_LIMITER_FIRST),
  },
  {
    name: "confirm: a token consumed between the read and the update is refused",
    klass: "A1-in",
    harmfulMove:
      "the transaction carrying on after its conditional UPDATE consumed no row, so two " +
      "concurrent confirms with one link both set a password and both stamp the account",
    files: [SERVICE],
    appliedMarkers: ["if (consumed.length === 0 && consumed.length !== 0) {"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        CONSUME_REFUSAL_CONDITION,
        "    if (consumed.length === 0 && consumed.length !== 0) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", SINGLE_USE_TEST], REACHED_SINGLE_USE),
  },
  {
    name: "confirm: the consume only matches a token that is still unconsumed",
    klass: "A1-in",
    harmfulMove:
      "the conditional UPDATE matching on the row id alone, so it always touches a row, the " +
      "refusal after it can never fire, and two concurrent confirms with one link both succeed",
    files: [SERVICE],
    appliedMarkers: [`and(\n          eq(userPasswordResetTokens.id, tokenRecord.id),\n        ),`],
    mutate: () =>
      substituteOnce(
        SERVICE,
        CONSUME_UNCONSUMED_PREDICATE,
        "          eq(userPasswordResetTokens.id, tokenRecord.id),\n",
      ),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_STALE_READ),
  },
  {
    name: "jwt callback: signedInAtMs is minted at sign-in and never again",
    klass: "D",
    harmfulMove:
      "the claim re-minted on every jwt call, so a refreshed token is dated after the stamp and a " +
      "password change signs nobody out. Read-only: the move is the probe, removal is covered by " +
      "the sign-in claim test",
    files: [AUTH_CONFIG],
    appliedMarkers: [
      `delete token.mfaVerifiedAt;\n      }\n      token.signedInAtMs = Date.now();`,
    ],
    mutate: () =>
      substituteOnce(
        AUTH_CONFIG,
        SIGN_IN_CLAIM_MINT,
        "        delete token.mfaVerifiedAt;\n      }\n      token.signedInAtMs = Date.now();\n",
      ),
    detect: async () => fails("npx", ["vitest", "run", ...REVOCATION_TESTS], REACHED_CLAIM_KEPT),
  },
  {
    name: "change: the current password's length is judged BEFORE it is verified",
    klass: "B",
    harmfulMove:
      "parseCurrentPassword running below verifyPassword, so an over-length current password " +
      "reaches the hash and a mismatch is counted as a failed attempt, where sign-in refuses it " +
      "before any scrypt work and counts nothing",
    files: [SERVICE],
    appliedMarkers: [
      "verifyPassword(currentPassword.trim(), account.passwordHash);\n  parseCurrentPassword(currentPassword);",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        VERIFY_CALL,
        "  const currentMatches = await verifyPassword(currentPassword.trim(), account.passwordHash);\n" +
          "  parseCurrentPassword(currentPassword);",
      ),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_LENGTH_FIRST),
  },
  {
    name: "change: the current password's length is judged at all",
    klass: "B",
    harmfulMove:
      "the current password's length never judged, so an over-length current password reaches " +
      "the hash and a mismatch is counted as a failed attempt, where sign-in refuses it before " +
      "any scrypt work and counts nothing",
    files: [SERVICE],
    appliedMarkers: [
      "verifyPassword(currentPassword.trim(), account.passwordHash);\n  void parseCurrentPassword;",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        VERIFY_CALL,
        "  const currentMatches = await verifyPassword(currentPassword.trim(), account.passwordHash);\n" +
          "  void parseCurrentPassword;",
      ),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], REACHED_LENGTH_FIRST),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("password-recovery", [
    ["npx", ["vitest", "run", ROUTE_TEST, SERVICE_TEST, SINGLE_USE_TEST, ...REVOCATION_TESTS]],
  ]);
  await runProbes(probes);
}
