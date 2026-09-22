import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL } from "@/lib/institutions/reach-caps";
import type { CompetitionPublishBlockerCode } from "@/server/competitions/competition-publish-readiness";

// Every Indonesian word the publish control says, in one place, because two shells say it.
//
// The detail shell and the edit shell are separate components that share one server answer
// (`resolveCompetitionPublishReadiness`) and one endpoint. The refusals arrive as CODES, and the
// server's own messages are English — they are written for a log and for an operator, not for the
// recruiter who pressed the button. So the translation happens here, and the English message never
// reaches a toast on this path. Two copies of this map would be two chances to translate one code
// two ways, which is the shape the shared-module rule exists to prevent.
//
// The code type is imported TYPE-ONLY: `@/server/competitions/competition-publish-readiness` is a
// server module and imports the Drizzle schema at its top, and this file is bundled into the
// browser. `import type` erases, so the union arrives without the module.

/** Where a reason's link goes. Resolved to an href by `resolvePublishReasonHref`. */
export type PublishReasonLinkKind = "verification" | "edit" | "recruiter";

export type PublishBlockerReason = {
  code: CompetitionPublishBlockerCode;
  text: string;
  link: { kind: PublishReasonLinkKind; label: string } | null;
};

const REASONS: Record<CompetitionPublishBlockerCode, PublishBlockerReason> = {
  forbidden: {
    code: "forbidden",
    text: "Hanya pemilik institusi yang dapat menerbitkan kompetisi.",
    link: null,
  },
  // No link: no surface this app renders can turn a published competition back into a draft, so the
  // sentence names the state rather than pointing at a next step that does not exist.
  competition_invalid_transition: {
    code: "competition_invalid_transition",
    text: "Hanya kompetisi berstatus draf yang dapat diterbitkan.",
    link: null,
  },
  competition_recruiter_not_trusted: {
    code: "competition_recruiter_not_trusted",
    text: "Akun Anda belum menjadi Trusted Recruiter. Selesaikan verifikasi rekruter untuk dapat menerbitkan kompetisi.",
    // There is no dedicated recruiter-verification ROUTE in this app: the verification panel is
    // rendered on `/recruiter-dashboard` (app/recruiter-dashboard/recruiter-verification-panel.tsx,
    // mounted by that page). The dashboard is therefore the page the link names — the link's text
    // says what to do there rather than claiming a page that does not exist.
    link: { kind: "recruiter", label: "Verifikasi rekruter" },
  },
  institution_suspended: {
    code: "institution_suspended",
    text: "Institusi ini sedang ditangguhkan oleh tim Lombakita. Kompetisi tidak dapat diterbitkan.",
    link: null,
  },
  competition_publish_validation_failed: {
    code: "competition_publish_validation_failed",
    text: "Data kompetisi belum lengkap atau belum valid.",
    link: { kind: "edit", label: "Buka halaman edit" },
  },
  competition_institution_not_verified: {
    code: "competition_institution_not_verified",
    text: "Kompetisi berbayar hanya dapat diterbitkan oleh institusi yang sudah terverifikasi.",
    link: { kind: "verification", label: "Ajukan verifikasi" },
  },
  competition_personal_individual_only: {
    code: "competition_personal_individual_only",
    text: "Institusi pribadi hanya dapat menjalankan kompetisi individu.",
    link: null,
  },
  competition_personal_publish_limit: {
    code: "competition_personal_publish_limit",
    // The cap is IMPORTED. A literal here would be a second definition of the number the server
    // enforces, and the sentence would keep promising a limit the server had stopped applying.
    text: `Institusi pribadi dapat memiliki paling banyak ${MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL} kompetisi yang diterbitkan.`,
    link: null,
  },
};

export const getPublishBlockerReason = (
  code: CompetitionPublishBlockerCode,
): PublishBlockerReason => REASONS[code];

export const resolvePublishReasonHref = (
  kind: PublishReasonLinkKind,
  context: { institutionSlug: string; competitionSlug: string },
): string => {
  const institution = `/institution/${encodeURIComponent(context.institutionSlug)}`;
  switch (kind) {
    case "verification":
      return `${institution}/verification`;
    case "edit":
      return `${institution}/competitions/${encodeURIComponent(context.competitionSlug)}/edit`;
    case "recruiter":
      return "/recruiter-dashboard";
  }
};

/** Shown when the server refused for a reason this module does not recognise, or named no code. */
export const PUBLISH_REFUSAL_FALLBACK_TEXT =
  "Kompetisi gagal diterbitkan. Coba lagi atau hubungi dukungan Lombakita.";

// Two codes have a TOAST that differs from their REASON, because in both the reason describes a
// state and the toast describes what the server just told this particular attempt:
// `competition_publish_validation_failed` names the failing fields, and
// `competition_invalid_transition` says the status changed underneath the caller. Every other code
// refuses for a reason that does not change between the control and the attempt.
const VALIDATION_FAILED_TOAST_PREFIX = "Data kompetisi belum lengkap";

export const resolvePublishRefusalToastText = (
  code: string | null | undefined,
  failures?: ReadonlyArray<{ field: string }>,
): string => {
  if (code === "competition_publish_validation_failed") {
    const labels = [
      ...new Set((failures ?? []).map((failure) => getCompetitionFieldLabel(failure.field))),
    ];
    // No field list to name — the envelope carried no `details.failures`. The sentence drops the
    // clause rather than trailing a colon with nothing after it.
    return labels.length > 0
      ? `${VALIDATION_FAILED_TOAST_PREFIX}: ${labels.join(", ")}.`
      : `${VALIDATION_FAILED_TOAST_PREFIX}.`;
  }

  if (code === "competition_not_found") return "Kompetisi tidak ditemukan.";
  if (code === "competition_invalid_transition") {
    return "Status kompetisi sudah berubah. Muat ulang halaman lalu coba lagi.";
  }

  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(REASONS, code)) {
    return REASONS[code as CompetitionPublishBlockerCode].text;
  }

  return PUBLISH_REFUSAL_FALLBACK_TEXT;
};
