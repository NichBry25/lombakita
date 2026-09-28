/*
 * Rule 36 probes for MANUAL-D57, the shared presigned-upload budget.
 *
 * Twelve entry points mint presigned PUT URLs into this platform's R2 bucket, and the budget is one
 * counter across all of them. The limiter is a function call at the top of a request handler, and
 * the harm it exists to prevent is a URL being handed out — so there are two ways for it to be
 * wrong while everything still looks right:
 *
 *   1. REMOVED. That route is unbounded again while the others keep the ceiling. Every status-code
 *      assertion on a request that is not over its limit stays green.
 *   2. MOVED below the presign service call. It still answers 429 — for a URL that was already
 *      signed and discarded. The status code cannot tell the two apart, which is the shape Rule 32
 *      is written about.
 *
 * CLASS C — route gates. The detector is that the SERVICE IS NOT CALLED, never the status alone.
 *
 * THREE GUARD LOCATIONS, BOTH DIRECTIONS EACH, WHICH IS SIX PROBES. The eight call sites are three
 * shapes: six direct routes (one shape, five copies) and two wrappers (`runOwned` in
 * profile-file-http.ts and institution-media-http.ts, each serving several routes). Each guard
 * location is probed directly; that every one of the twelve CALL SITES carries the call, and
 * carries it before its own presign, is asserted mechanically over the whole table by
 * src/server/storage/upload-rate-limit-wiring.test.ts, which names the entry point that broke.
 *
 * TWO MORE PROBES ASK THE SECOND DIRECTION OF THE SAME QUESTION. The budget is an allowance to mint
 * presigned URLs, and the wrappers draw it in a shared helper that also serves handlers which mint
 * nothing — recording a key, deleting a file, flipping resume visibility. A record or delete handler
 * that drifts onto the minting entry point still refuses correctly and still refuses before any
 * presign, because it performs none; the harm is that the allowance is spent by work the budget does
 * not bound, so the upload it exists to bound is what gets refused. Every route assertion above stays
 * green through it. The wiring test's `does not draw the budget` cases are the detector.
 *
 * TWO MORE PROBES ASK THAT SCAN TO FAIL. The wiring test is the instrument, not a behavioural test,
 * and an instrument that runs but cannot fail is not one (Rule 38). Every route above asserts a
 * response; nothing above would notice if the wiring test's table were quietly satisfied by a file
 * it no longer read. So the same two harmful moves are applied once more with the wiring test as
 * the detector: guard deleted (the call it scans for is gone) and guard moved below the presign (the
 * ordering it asserts is violated). Both must name a specific failing case.
 *
 * EACH PROBE'S DETECTOR NAMES A CASE THAT ISOLATES ONE DIRECTION. The 429 case asserts the status
 * and nothing about the service; the mint case asserts the service and nothing about the status.
 * A single case asserting both would let a probe cite an assertion the other probe's mutation also
 * breaks, and the evidence line would not say which experiment ran.
 *
 * Usage: node scripts/testing/probes/upload-rate-limit.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SUBMISSION_ROUTE =
  "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/submission/upload-url/route.ts";
const PROFILE_WRAPPER = "src/server/user-profile/profile-file-http.ts";
const MEDIA_WRAPPER = "src/server/institution-workspace/institution-media-http.ts";

const SUBMISSION_TEST =
  "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/submission/upload-url/route.test.ts";
const AVATAR_TEST = "src/app/api/v1/users/me/profile/uploads/avatar/upload-url/route.test.ts";
const LOGO_TEST = "src/app/api/v1/institutions/[institutionSlug]/profile/logo/route.test.ts";

/** The guard block as every one of the eight call sites writes it. */
const GUARD = `    const limited = await assertUploadUrlAllowed(session.user.id);
    if (limited) return limited;

`;

/** The same block with its condition neutered, so it compiles and can never refuse. */
const NEUTERED = "if (limited && !limited) return limited;";

/**
 * Moves the refusal below the presign it exists to prevent, which is the harmful move for a class C
 * gate.
 *
 * Removed from its own position FIRST, so the probe cannot pass on a file that simply gained a
 * second copy of the guard while keeping the original one above the mint.
 */
const moveGuardBelow = (file, mintAnchor, moved) => {
  substituteOnce(file, GUARD, "");
  substituteOnce(file, mintAnchor, moved);
};

const DIRECT_MOVED = `    const limited = await assertUploadUrlAllowed(session.user.id);
    if (limited) return limited;

    return NextResponse.json(grant);`;

const WRAPPER_MOVED = `    const response = await handler(session.user.id);

    const limited = await assertUploadUrlAllowed(session.user.id);
    if (limited) return limited;

    return response;`;

const REACHED_STATUS = /× .*refuses an over-budget request with 429/;
const REACHED_MINT = /× .*does not mint an upload URL for a request the budget refuses/;

/**
 * The same direct route read as SOURCE rather than exercised as behaviour, which is what makes the
 * wiring scan non-vacuous. Only this file's two rows of the twelve-entry table can fail from a
 * mutation applied here, so each detector names the case it expects rather than accepting any red.
 *
 * The quotes are load-bearing. vitest wraps an `it.each` case's interpolated `$name` in single
 * quotes and prints that quoted form on both the progress line and the failure block, so a pattern
 * written against the unquoted name matches neither. The `×` and `FAIL` prefixes are NOT load
 * bearing and are deliberately left out: only the failure block carries the file path, only the
 * progress line carries the duration, and both carry the name.
 */
const WIRING_TEST = "src/server/storage/upload-rate-limit-wiring.test.ts";
const WIRING_CAUGHT_REMOVAL = /'submission file': the route file is its own guard/;
const WIRING_CAUGHT_MOVE = /'submission file': the limiter call precedes the presign call/;
const WIRING_CAUGHT_RECORD = /'candidate avatar record': does not draw the budget/;
const WIRING_CAUGHT_DELETE = /'institution media delete': does not draw the budget/;

/** A record handler re-pointed at the minting entry point. */
const RECORD_BEFORE = `export const avatarRecord = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {`;
const RECORD_AFTER = `export const avatarRecord = (request: Request): Promise<Response> =>
  runOwnedUploadUrl(request, async (userId) => {`;

/**
 * A delete handler re-pointed the same way.
 *
 * Anchored on the service call rather than on the signature: this export's parameters span four
 * lines, and the call it makes is what makes the anchor unique either way.
 */
const DELETE_BEFORE = `  runOwned(request, async (userId) => {
    await deleteInstitutionMedia(userId, institutionSlug, kind);`;
const DELETE_AFTER = `  runOwnedUploadUrl(request, async (userId) => {
    await deleteInstitutionMedia(userId, institutionSlug, kind);`;

/**
 * What the deleted guard leaves behind, so the mutation is one the harness can see APPLIED.
 *
 * A deletion writes no new text, and `appliedMarkers` is how the harness proves the move landed
 * rather than silently failing to match. The wiring test strips comments before scanning, so this
 * cannot satisfy the presence check the removal is meant to break.
 */
const GUARD_REMOVED = "    // probe: the shared budget call removed from this route\n";

export const probes = [
  // ── The direct-route shape, on the submission upload URL ─────────────────────────────────────
  {
    name: "submission upload URL: the budget is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running but never refusing, so a candidate is handed unbounded presigned " +
      "upload URLs while the route reports itself as rate limited",
    files: [SUBMISSION_ROUTE],
    appliedMarkers: [NEUTERED],
    mutate: () => substituteOnce(SUBMISSION_ROUTE, "if (limited) return limited;", NEUTERED),
    detect: async () => fails("npx", ["vitest", "run", SUBMISSION_TEST], REACHED_STATUS),
  },
  {
    name: "submission upload URL: the budget refuses BEFORE the URL is signed",
    klass: "C",
    harmfulMove:
      "the refusal sitting below generateSubmissionUploadUrl, so the presigned URL is minted and " +
      "handed to nobody before the caller is told the request was refused",
    files: [SUBMISSION_ROUTE],
    appliedMarkers: [DIRECT_MOVED],
    mutate: () =>
      moveGuardBelow(SUBMISSION_ROUTE, "    return NextResponse.json(grant);", DIRECT_MOVED),
    detect: async () => fails("npx", ["vitest", "run", SUBMISSION_TEST], REACHED_MINT),
  },

  // ── The profile wrapper, serving four upload-URL routes ──────────────────────────────────────
  {
    name: "profile uploads: the budget is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running in runOwned but never refusing, so avatar, banner, resume and " +
      "certification upload URLs are all unbounded at once while each route looks bounded",
    files: [PROFILE_WRAPPER],
    appliedMarkers: [NEUTERED],
    mutate: () => substituteOnce(PROFILE_WRAPPER, "if (limited) return limited;", NEUTERED),
    detect: async () => fails("npx", ["vitest", "run", AVATAR_TEST], REACHED_STATUS),
  },
  {
    name: "profile uploads: the budget refuses BEFORE the URL is signed",
    klass: "C",
    harmfulMove:
      "the refusal sitting below the handler call in runOwned, so every profile presign runs and " +
      "the caller is told it was refused after the URL has already been signed",
    files: [PROFILE_WRAPPER],
    appliedMarkers: [WRAPPER_MOVED],
    mutate: () =>
      moveGuardBelow(PROFILE_WRAPPER, "    return await handler(session.user.id);", WRAPPER_MOVED),
    detect: async () => fails("npx", ["vitest", "run", AVATAR_TEST], REACHED_MINT),
  },

  // ── The institution media wrapper, serving the logo and banner routes ────────────────────────
  {
    name: "institution media: the budget is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running in runOwned but never refusing, so logo and banner upload URLs are " +
      "unbounded while both routes appear to be rate limited",
    files: [MEDIA_WRAPPER],
    appliedMarkers: [NEUTERED],
    mutate: () => substituteOnce(MEDIA_WRAPPER, "if (limited) return limited;", NEUTERED),
    detect: async () => fails("npx", ["vitest", "run", LOGO_TEST], REACHED_STATUS),
  },
  {
    name: "institution media: the budget refuses BEFORE the URL is signed",
    klass: "C",
    harmfulMove:
      "the refusal sitting below the handler call in runOwned, so the institution logo presign " +
      "runs and the caller is told it was refused after the URL has already been signed",
    files: [MEDIA_WRAPPER],
    appliedMarkers: [WRAPPER_MOVED],
    mutate: () =>
      moveGuardBelow(MEDIA_WRAPPER, "    return await handler(session.user.id);", WRAPPER_MOVED),
    detect: async () => fails("npx", ["vitest", "run", LOGO_TEST], REACHED_MINT),
  },

  // ── The budget charged for work it does not bound ───────────────────────────────────────────
  {
    name: "avatar record: a handler that mints nothing does not draw the budget",
    klass: "C",
    harmfulMove:
      "the record handler re-pointed at the minting entry point, so recording an avatar key the " +
      "browser already uploaded spends the allowance that exists to bound handing out presigned URLs",
    files: [PROFILE_WRAPPER],
    appliedMarkers: [RECORD_AFTER],
    mutate: () => substituteOnce(PROFILE_WRAPPER, RECORD_BEFORE, RECORD_AFTER),
    detect: async () => fails("npx", ["vitest", "run", WIRING_TEST], WIRING_CAUGHT_RECORD),
  },
  {
    name: "institution media delete: a handler that mints nothing does not draw the budget",
    klass: "C",
    harmfulMove:
      "the delete handler re-pointed at the minting entry point, so removing an institution logo " +
      "spends the same allowance as minting an upload URL",
    files: [MEDIA_WRAPPER],
    appliedMarkers: [DELETE_AFTER],
    mutate: () => substituteOnce(MEDIA_WRAPPER, DELETE_BEFORE, DELETE_AFTER),
    detect: async () => fails("npx", ["vitest", "run", WIRING_TEST], WIRING_CAUGHT_DELETE),
  },

  // ── The wiring scan itself, which is an instrument and must be able to fail ──────────────────
  {
    name: "the wiring scan: a guard deleted from a route is not a green scan",
    klass: "C",
    harmfulMove:
      "the call removed outright, so this route is unbounded and the scan that exists to name the " +
      "entry point that broke reports a clean tree",
    files: [SUBMISSION_ROUTE],
    appliedMarkers: [GUARD_REMOVED],
    // Only the call is removed. Taking the import with it would break a second, unrelated assertion
    // in the same scan, and a probe that reddens two things cannot say which one its detector saw.
    mutate: () => substituteOnce(SUBMISSION_ROUTE, GUARD, GUARD_REMOVED),
    detect: async () => fails("npx", ["vitest", "run", WIRING_TEST], WIRING_CAUGHT_REMOVAL),
  },
  {
    name: "the wiring scan: a guard moved below its presign is not a green scan",
    klass: "C",
    harmfulMove:
      "the refusal moved below the presign, so the scan that exists to assert ordering reports the " +
      "route as correctly ordered",
    files: [SUBMISSION_ROUTE],
    appliedMarkers: [DIRECT_MOVED],
    mutate: () =>
      moveGuardBelow(SUBMISSION_ROUTE, "    return NextResponse.json(grant);", DIRECT_MOVED),
    detect: async () => fails("npx", ["vitest", "run", WIRING_TEST], WIRING_CAUGHT_MOVE),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("upload-rate-limit", [
    ["npx", ["vitest", "run", SUBMISSION_TEST]],
    ["npx", ["vitest", "run", AVATAR_TEST]],
    ["npx", ["vitest", "run", LOGO_TEST]],
    ["npx", ["vitest", "run", WIRING_TEST]],
  ]);
  await runProbes(probes);
}
