// WHAT THE PUBLISH CONTROL SAYS, AND WHAT IT MUST NEVER SAY.
//
// Two shells render the publish control from one server answer, so the words live in one module and
// these tests are the copy of the copy: each refusal code is pinned to its exact Indonesian reason,
// its link, and its toast.
//
// The load-bearing test here is the last one. The server's refusal messages are English sentences
// written for a log — "Publishing requires a Trusted Recruiter account — complete recruiter
// verification first" — and the endpoint returns them alongside the code. A shell that relayed
// `error.message` would look correct in every single-code assertion above and hand an Indonesian
// user an English log line. So the set of texts this module can produce is checked against the set
// the server can send, and the two must not intersect.

import { describe, expect, it } from "vitest";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL } from "@/lib/institutions/reach-caps";
import type { CompetitionPublishBlockerCode } from "@/server/competitions/competition-publish-readiness";
import {
  PUBLISH_REFUSAL_FALLBACK_TEXT,
  getPublishBlockerReason,
  resolvePublishReasonHref,
  resolvePublishRefusalToastText,
} from "@/components/institution/competition-publish-messages";

const BLOCKER_CODES: CompetitionPublishBlockerCode[] = [
  "forbidden",
  "competition_recruiter_not_trusted",
  "institution_suspended",
  "competition_publish_validation_failed",
  "competition_institution_not_verified",
  "competition_personal_individual_only",
  "competition_personal_publish_limit",
];

// The refusal messages the server actually sends, quoted from the functions the publish path calls:
// assertCompetitionAccess (competition-access.ts:162,165), assertActorIsTrustedRecruiter (:215),
// assertInstitutionNotSuspended (:302), transitionCompetitionStatus (competition-service.ts:889),
// assertInstitutionVerified (competition-access.ts:274), assertPersonalCompetitionPublishable
// (:342, :391), assertCompetitionInInstitution (competition-service.ts:133), and
// isAllowedStatusTransition (competition-service.ts:859).
const SERVER_REFUSAL_MESSAGES = [
  "Institution owner/staff access required",
  "institution_owner access required",
  "Publishing requires a Trusted Recruiter account — complete recruiter verification first",
  "This institution has been suspended by platform ops",
  "Cannot publish: 3 validation issue(s) — see details.failures",
  "Institusi harus terverifikasi sebelum dapat memungut biaya pendaftaran. Kompetisi gratis tetap dapat dipublikasikan.",
  "A personal institution can only run individual-mode competitions",
  `A personal institution may have at most ${MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL} published competitions`,
  "Competition not found",
  "Cannot transition competition from 'draft' to 'published'",
];

describe("publish blocker reasons", () => {
  it("names every blocker code with the reason the shell shows", () => {
    const reasons: Record<CompetitionPublishBlockerCode, string> = {
      forbidden: "Hanya pemilik institusi yang dapat menerbitkan kompetisi.",
      competition_recruiter_not_trusted:
        "Akun Anda belum menjadi Trusted Recruiter. Selesaikan verifikasi rekruter untuk dapat menerbitkan kompetisi.",
      institution_suspended:
        "Institusi ini sedang ditangguhkan oleh tim Lombakita. Kompetisi tidak dapat diterbitkan.",
      competition_publish_validation_failed: "Data kompetisi belum lengkap atau belum valid.",
      competition_institution_not_verified:
        "Kompetisi berbayar hanya dapat diterbitkan oleh institusi yang sudah terverifikasi.",
      competition_personal_individual_only:
        "Institusi pribadi hanya dapat menjalankan kompetisi individu.",
      competition_personal_publish_limit: `Institusi pribadi dapat memiliki paling banyak ${MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL} kompetisi yang diterbitkan.`,
    };

    for (const code of BLOCKER_CODES) {
      expect(getPublishBlockerReason(code).text, code).toBe(reasons[code]);
      expect(getPublishBlockerReason(code).code, code).toBe(code);
    }
  });

  it("links only the reasons that name a next step, and labels each one", () => {
    const links: Record<CompetitionPublishBlockerCode, string | null> = {
      forbidden: null,
      competition_recruiter_not_trusted: "Verifikasi rekruter",
      institution_suspended: null,
      competition_publish_validation_failed: "Buka halaman edit",
      competition_institution_not_verified: "Ajukan verifikasi",
      competition_personal_individual_only: null,
      competition_personal_publish_limit: null,
    };

    for (const code of BLOCKER_CODES) {
      const { link } = getPublishBlockerReason(code);
      expect(link?.label ?? null, code).toBe(links[code]);
    }
  });

  it("names the personal reach cap from the shared constant, never a literal", () => {
    // A hardcoded 3 that outlived a change to the constant would keep promising a limit the server
    // had stopped applying.
    expect(getPublishBlockerReason("competition_personal_publish_limit").text).toContain(
      String(MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL),
    );
  });

  it("resolves each link kind to a path, encoding the slugs it carries", () => {
    const context = { institutionSlug: "pt contoh", competitionSlug: "lomba/a" };
    expect(resolvePublishReasonHref("verification", context)).toBe(
      "/institution/pt%20contoh/verification",
    );
    expect(resolvePublishReasonHref("edit", context)).toBe(
      "/institution/pt%20contoh/competitions/lomba%2Fa/edit",
    );
    expect(resolvePublishReasonHref("recruiter", context)).toBe("/recruiter-dashboard");
  });
});

describe("publish refusal toasts", () => {
  it("uses the reason's own sentence for every readiness code", () => {
    // `competition_publish_validation_failed` is the one code whose TOAST differs from its REASON:
    // the reason is the sentence a disabled control carries, and the toast is what the server just
    // told this particular attempt went wrong, so it names the fields. It is asserted on its own
    // below.
    for (const code of BLOCKER_CODES.filter((c) => c !== "competition_publish_validation_failed")) {
      expect(resolvePublishRefusalToastText(code), code).toBe(getPublishBlockerReason(code).text);
    }
  });

  it("names the failing fields for a validation refusal, de-duplicated and comma-joined", () => {
    const text = resolvePublishRefusalToastText("competition_publish_validation_failed", [
      { field: "description" },
      { field: "eventStartAt" },
      { field: "description" },
    ]);

    expect(text).toBe(
      `Data kompetisi belum lengkap: ${getCompetitionFieldLabel("description")}, ${getCompetitionFieldLabel("eventStartAt")}.`,
    );
    // De-duplicated: the repeated field contributes one label, not two.
    expect(text.match(new RegExp(getCompetitionFieldLabel("description"), "g"))).toHaveLength(1);
  });

  it("drops the clause when the envelope carried no field list", () => {
    expect(resolvePublishRefusalToastText("competition_publish_validation_failed", [])).toBe(
      "Data kompetisi belum lengkap.",
    );
    expect(resolvePublishRefusalToastText("competition_publish_validation_failed")).toBe(
      "Data kompetisi belum lengkap.",
    );
  });

  it("names the two non-readiness codes the endpoint can return", () => {
    expect(resolvePublishRefusalToastText("competition_not_found")).toBe(
      "Kompetisi tidak ditemukan.",
    );
    expect(resolvePublishRefusalToastText("competition_invalid_transition")).toBe(
      "Status kompetisi sudah berubah. Muat ulang halaman lalu coba lagi.",
    );
  });

  it("falls back on an unrecognised code and on no code at all", () => {
    expect(resolvePublishRefusalToastText("some_future_code")).toBe(PUBLISH_REFUSAL_FALLBACK_TEXT);
    expect(resolvePublishRefusalToastText(null)).toBe(PUBLISH_REFUSAL_FALLBACK_TEXT);
    expect(resolvePublishRefusalToastText(undefined)).toBe(PUBLISH_REFUSAL_FALLBACK_TEXT);
    expect(PUBLISH_REFUSAL_FALLBACK_TEXT).toBe(
      "Kompetisi gagal diterbitkan. Coba lagi atau hubungi dukungan Lombakita.",
    );
  });

  it("never produces a sentence the server itself would have sent", () => {
    const reachableTexts = [
      ...BLOCKER_CODES.map((code) => resolvePublishRefusalToastText(code)),
      resolvePublishRefusalToastText("competition_publish_validation_failed", [
        { field: "description" },
      ]),
      resolvePublishRefusalToastText("competition_not_found"),
      resolvePublishRefusalToastText("competition_invalid_transition"),
      resolvePublishRefusalToastText("unrecognised"),
      resolvePublishRefusalToastText(null),
    ];

    for (const text of reachableTexts) {
      expect(
        SERVER_REFUSAL_MESSAGES,
        `a toast relayed the server's own message: ${text}`,
      ).not.toContain(text);
    }
  });
});
