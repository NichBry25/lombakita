// @vitest-environment node

// EVERY PRESIGNED-UPLOAD ENTRY POINT DRAWS THE SHARED BUDGET, AND DRAWS IT BEFORE IT MINTS.
//
// The limiter is a function call in the middle of a request handler, and the harm it exists to
// prevent is a presigned URL being handed out. Two failures produce identical observable behaviour
// on the happy path and neither shows up in a unit test of the limiter itself:
//
//   1. The call is REMOVED from one of the entry points. That route is unbounded again while the
//      other eleven keep the ceiling, so the platform reports a bound it is not enforcing.
//   2. The call is MOVED below the presign service call. It still returns 429 — after the URL has
//      already been signed and returned to nobody. The refusal is real and the harm already done.
//
// The second is the shape Rule 32 is written about: a guard can only be written at function scope,
// so it cannot be moved inside a conditional, but it CAN be moved down a line, and the 429 that
// still appears makes a status-code assertion pass over it. That is why this is a source scan and
// not a response assertion.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8").replace(/\s*\n\s*/g, " ");

/**
 * The same source with comments stripped.
 *
 * Required here because several of these files EXPLAIN the limiter in prose. A comment saying
 * "the shared budget is drawn here" satisfies a whole-file substring check for the call it
 * describes, so the presence assertion would pass on a file whose call had been deleted.
 */
const readCode = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s*\n\s*/g, " ");

const LIMITER = "src/server/storage/upload-rate-limit.ts";
const CALL = "await assertUploadUrlAllowed(";

type EntryPoint = {
  /** How the failure is named when this entry point is the one broken. */
  name: string;
  /** The route file a request enters through. */
  route: string;
  /** The file that must contain the limiter call serving this route. */
  guard: string;
  /** The presign service call the limiter must precede in `guard`. */
  presign: string;
  /** Wrapper-served routes only: the handler the route re-exports. */
  handler?: string;
  /** Wrapper-served routes only: the module that handler is imported from. */
  handlerModule?: string;
};

const PROFILE_WRAPPER = "src/server/user-profile/profile-file-http.ts";
const MEDIA_WRAPPER = "src/server/institution-workspace/institution-media-http.ts";

const ENTRY_POINTS: EntryPoint[] = [
  // ── Direct: the call sits in the route file itself ───────────────────────────────────────────
  {
    name: "institution QRIS image",
    route:
      "src/app/api/v1/institutions/[institutionSlug]/payment-instructions/qris-upload-url/route.ts",
    guard:
      "src/app/api/v1/institutions/[institutionSlug]/payment-instructions/qris-upload-url/route.ts",
    presign: "generateQrisUploadUrl(",
  },
  {
    name: "candidate payment proof",
    route:
      "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/payment/upload-url/route.ts",
    guard:
      "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/payment/upload-url/route.ts",
    presign: "generateManualProofUploadUrl(",
  },
  {
    name: "submission file",
    route:
      "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/submission/upload-url/route.ts",
    guard:
      "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/submission/upload-url/route.ts",
    presign: "generateSubmissionUploadUrl(",
  },
  {
    name: "registration document request file",
    route: "src/app/api/v1/me/document-requests/[requestId]/files/route.ts",
    guard: "src/app/api/v1/me/document-requests/[requestId]/files/route.ts",
    presign: "prepareRequestDocumentUpload(",
  },
  {
    name: "recruiter verification document",
    route: "src/app/api/v1/recruiter/me/verification/documents/route.ts",
    guard: "src/app/api/v1/recruiter/me/verification/documents/route.ts",
    presign: "prepareVerificationDocumentUpload(",
  },
  {
    name: "institution verification submission",
    route: "src/app/api/v1/institutions/[institutionSlug]/verification/submit/route.ts",
    guard: "src/app/api/v1/institutions/[institutionSlug]/verification/submit/route.ts",
    presign: "createVerificationSubmission(",
  },

  // ── Wrapper-served: the call sits in the shared runOwned, one per wrapper ────────────────────
  {
    name: "candidate avatar",
    route: "src/app/api/v1/users/me/profile/uploads/avatar/upload-url/route.ts",
    guard: PROFILE_WRAPPER,
    presign: "generateAvatarUploadUrl(",
    handler: "avatarUploadUrl",
    handlerModule: "@/server/user-profile/profile-file-http",
  },
  {
    name: "candidate banner",
    route: "src/app/api/v1/users/me/profile/uploads/banner/upload-url/route.ts",
    guard: PROFILE_WRAPPER,
    presign: "generateBannerUploadUrl(",
    handler: "bannerUploadUrl",
    handlerModule: "@/server/user-profile/profile-file-http",
  },
  {
    name: "candidate resume",
    route: "src/app/api/v1/users/me/profile/uploads/resume/upload-url/route.ts",
    guard: PROFILE_WRAPPER,
    presign: "generateResumeUploadUrl(",
    handler: "resumeUploadUrl",
    handlerModule: "@/server/user-profile/profile-file-http",
  },
  {
    name: "candidate certification file",
    route: "src/app/api/v1/users/me/profile/uploads/certifications/[entryId]/upload-url/route.ts",
    guard: PROFILE_WRAPPER,
    presign: "generateCertificationFileUploadUrl(",
    handler: "certificationFileUploadUrl",
    handlerModule: "@/server/user-profile/profile-file-http",
  },
  {
    name: "institution logo",
    route: "src/app/api/v1/institutions/[institutionSlug]/profile/logo/route.ts",
    guard: MEDIA_WRAPPER,
    presign: "generateInstitutionMediaUploadUrl(",
    handler: "institutionMediaUploadUrl",
    handlerModule: "@/server/institution-workspace/institution-media-http",
  },
  {
    name: "institution banner",
    route: "src/app/api/v1/institutions/[institutionSlug]/profile/banner/route.ts",
    guard: MEDIA_WRAPPER,
    presign: "generateInstitutionMediaUploadUrl(",
    handler: "institutionMediaUploadUrl",
    handlerModule: "@/server/institution-workspace/institution-media-http",
  },
];

// The two families are separated rather than branched inside one assertion. A shared `it.each` that
// returned early for the family it did not apply to would report a pass for every direct route on an
// assertion that never ran against it.
const DIRECT = ENTRY_POINTS.filter((entry) => entry.handler === undefined);
const WRAPPED = ENTRY_POINTS.filter((entry) => entry.handler !== undefined);

describe("the entry-point table is classified exhaustively", () => {
  it("puts every entry point in exactly one family, and neither family is empty", () => {
    expect(DIRECT.length).toBe(6);
    expect(WRAPPED.length).toBe(6);
    expect(DIRECT.length + WRAPPED.length).toBe(ENTRY_POINTS.length);
    expect(new Set(ENTRY_POINTS.map((entry) => entry.name)).size).toBe(ENTRY_POINTS.length);
  });
});

describe("every upload-URL entry point draws the shared budget", () => {
  it.each(DIRECT)("$name: the route file is its own guard", ({ route, guard }) => {
    // A direct route whose limiter had been moved out into a helper nobody calls would still have a
    // guarded-looking file somewhere in the tree; this pins the call to the file the request enters.
    expect(guard).toBe(route);
    expect(readCode(route)).toContain(CALL);
  });

  it.each(WRAPPED)(
    "$name: the route reaches a guarded handler",
    ({ route, handler, handlerModule }) => {
      // The half a scan of the wrapper alone cannot see: the route must actually go through the
      // wrapper. Repointing it at the presign service directly would leave the wrapper's call intact,
      // every wrapper assertion above green, and this route unbounded.
      const source = readCode(route);

      // One handler per import list for the profile routes, three for the institution routes, so the
      // binding is asserted as "named by this import from this module" rather than as one exact line.
      const binding = new RegExp(`import \\{[^}]*\\b${handler}\\b[^}]*\\} from "${handlerModule}"`);

      expect(source).toMatch(binding);
      expect(source).toContain(`${handler}(`);
    },
  );

  it.each(ENTRY_POINTS)(
    "$name: the limiter call precedes the presign call",
    ({ guard, presign }) => {
      const source = readCode(guard);

      const guardAt = source.indexOf(CALL);
      const presignAt = source.indexOf(presign);

      expect(guardAt, `no ${CALL} in ${guard}`).toBeGreaterThan(-1);
      expect(presignAt, `no ${presign} in ${guard}`).toBeGreaterThan(-1);
      // Strictly before. Equal indices are impossible, but a guard that ran AFTER the presign would
      // return a 429 for a URL that had already been signed.
      expect(guardAt).toBeLessThan(presignAt);
    },
  );

  it.each(ENTRY_POINTS)("$name: the refusal returns before the handler work", ({ guard }) => {
    // Position alone does not make it a refusal: `const limited = await …` followed by nothing is a
    // call that runs and is discarded. The early return is what makes the 429 stop the request.
    const source = readCode(guard);

    expect(source).toContain(`${CALL}session.user.id)`);
    expect(source).toContain("if (limited) return limited;");
  });
});

describe("the budget is drawn at the choke points, not once per route", () => {
  it("calls the limiter exactly eight times across the tree", () => {
    // Six direct routes plus the two wrappers. Eleven would mean a wrapper call had been duplicated
    // into its route files (and the two would drift); seven would mean one had been deleted.
    const files = [...new Set(ENTRY_POINTS.map((entry) => entry.guard))];

    const counts = files.map((file) => ({
      file,
      count: readCode(file).split(CALL).length - 1,
    }));

    for (const { file, count } of counts) {
      expect(count, file).toBe(1);
    }
    expect(counts).toHaveLength(8);
  });

  it("defines the budget once, in the module every guard imports", () => {
    const source = readCode(LIMITER);

    expect(source.match(/export const UPLOAD_URL_RATE_LIMIT =/g)).toHaveLength(1);
    expect(source.match(/export const assertUploadUrlAllowed =/g)).toHaveLength(1);
    // One key shape, so two routes serving the same account draw the same counter.
    expect(source).toContain("key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}${userId}`");
  });

  it("is imported by every guard file, not re-implemented", () => {
    for (const file of [...new Set(ENTRY_POINTS.map((entry) => entry.guard))]) {
      // A local limiter written next to a route would pass every behavioural test above and give
      // that route its own private allowance.
      expect(readCode(file), file).toContain(
        'import { assertUploadUrlAllowed } from "@/server/storage/upload-rate-limit"',
      );
    }
  });
});

describe("the wiring scan is not vacuous", () => {
  it("reads real, non-trivial sources", () => {
    const files = [
      LIMITER,
      ...ENTRY_POINTS.map((entry) => entry.guard),
      ...ENTRY_POINTS.map((entry) => entry.route),
    ];

    for (const file of files) {
      // A file that had been emptied would satisfy every negative assertion and throw on none.
      expect(read(file).length, file).toBeGreaterThan(200);
    }
  });
});
