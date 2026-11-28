// WHAT THE PUBLISH CONTROL SAYS, AND WHAT IT MUST NEVER SAY.
//
// Two shells render the publish control from one server answer, so the words live in one module and
// these tests are the copy of the copy: each refusal code is pinned to its exact Indonesian reason,
// its link, and its toast.
//
// The load-bearing test here is the last one. The server's refusal messages are English sentences
// written for a log, such as "Publishing requires a trusted host, or a trusted owner of the
// institution", and the endpoint returns them alongside the code. A shell that relayed
// `error.message` would look correct in every single-code assertion above and hand an Indonesian
// user an English log line. So the set of texts this module can produce is checked against the set
// the server can send, and the two must not intersect.

import { describe, expect, it } from "vitest";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import type { CompetitionPublishBlockerCode } from "@/server/competitions/competition-publish-readiness";
import {
  HOST_CHECK_SENT_TOAST_TEXT,
  PUBLISH_REFUSAL_FALLBACK_TEXT,
  describePublishControl,
  getPublishBlockerReason,
  resolvePublishReasonHref,
  resolvePublishRefusalToastText,
} from "@/components/institution/competition-publish-messages";

const BLOCKER_CODES: CompetitionPublishBlockerCode[] = [
  "forbidden",
  "competition_invalid_transition",
  "institution_suspended",
  "competition_publish_validation_failed",
  "competition_organizer_contact_missing",
  "competition_audience_missing",
  "competition_institution_not_verified",
];

const TITLE_OTHER = "Lomba Poster Digital";
const WAIT_SENTENCE = "Perkiraan 1x24 jam pada hari kerja.";
const TITLED_OTHER_DRAFT_SENTENCE =
  'Kompetisi "Lomba Poster Digital" masih diperiksa staf. Tunggu hasilnya sebelum mengirim kompetisi lain.';
const UNTITLED_OTHER_DRAFT_SENTENCE =
  "Kompetisi lain Anda masih diperiksa staf. Tunggu hasilnya sebelum mengirim kompetisi lain.";
const KONTAK_TEXT = "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.";

// The refusal messages the server actually sends, quoted from the functions the publish path calls:
// assertCompetitionAccess (competition-access.ts:162,165), assertPublishTrustSatisfied (:215),
// assertInstitutionNotSuspended (:302), transitionCompetitionStatus (competition-service.ts:889),
// assertInstitutionVerified (competition-access.ts:274), assertCompetitionInInstitution
// (competition-service.ts:133),
// isAllowedStatusTransition (competition-service.ts:859), and
// assertCompetitionHasOrganizerContact (competition-access.ts).
const SERVER_REFUSAL_MESSAGES = [
  "Institution owner/staff access required",
  "institution_owner access required",
  "Publishing requires a trusted host, or a trusted owner of the institution",
  "This institution has been suspended by platform ops",
  "Cannot publish: 3 validation issue(s) — see details.failures",
  "Institusi harus terverifikasi sebelum dapat memungut biaya pendaftaran. Kompetisi gratis tetap dapat dipublikasikan.",
  "Competition not found",
  "Cannot transition competition from 'draft' to 'published'",
  "Publishing requires an organizer contact",
  "Publishing requires an audience (Untuk)",
  "Another draft of this account is waiting for its host check",
  "A host check needs a name and a phone number, and this account has neither",
];

describe("publish blocker reasons", () => {
  it("names every blocker code with the reason the shell shows", () => {
    const reasons: Record<CompetitionPublishBlockerCode, string> = {
      forbidden: "Hanya pemilik dan staf institusi yang dapat menerbitkan kompetisi.",
      competition_invalid_transition: "Hanya kompetisi berstatus draf yang dapat diterbitkan.",
      institution_suspended:
        "Institusi ini sedang ditangguhkan oleh tim Lombakita. Kompetisi tidak dapat diterbitkan.",
      competition_publish_validation_failed: "Data kompetisi belum lengkap atau belum valid.",
      competition_organizer_contact_missing:
        "Kontak untuk peserta belum diisi. Isi nomor WhatsApp, nomor telepon, atau email yang dapat dihubungi peserta.",
      competition_audience_missing:
        "Untuk siapa kompetisi ini belum diisi. Pilih minimal satu pilihan Untuk di bagian Kelayakan.",
      competition_institution_not_verified:
        "Kompetisi berbayar hanya dapat diterbitkan oleh institusi yang sudah terverifikasi.",
    };

    for (const code of BLOCKER_CODES) {
      expect(getPublishBlockerReason(code).text, code).toBe(reasons[code]);
      expect(getPublishBlockerReason(code).code, code).toBe(code);
    }
  });

  it("links only the reasons that name a next step, and labels each one", () => {
    const links: Record<CompetitionPublishBlockerCode, string | null> = {
      forbidden: null,
      competition_invalid_transition: null,
      institution_suspended: null,
      competition_publish_validation_failed: null,
      competition_organizer_contact_missing: "Isi kontak",
      competition_audience_missing: "Isi Untuk",
      competition_institution_not_verified: "Ajukan verifikasi",
    };

    for (const code of BLOCKER_CODES) {
      const { link } = getPublishBlockerReason(code);
      expect(link?.label ?? null, code).toBe(links[code]);
    }
  });

  it("points the missing-contact reason at the editor", () => {
    expect(getPublishBlockerReason("competition_organizer_contact_missing").link).toEqual({
      kind: "edit",
      label: "Isi kontak",
    });
  });

  it("resolves each link kind to a path, encoding the slugs it carries", () => {
    const context = { institutionSlug: "pt contoh", competitionSlug: "lomba/a" };
    expect(resolvePublishReasonHref("verification", context)).toBe(
      "/institution/pt%20contoh/verification",
    );
    expect(resolvePublishReasonHref("edit", context)).toBe(
      "/institution/pt%20contoh/competitions/lomba%2Fa/edit",
    );
  });
});

describe("publish refusal toasts", () => {
  it("uses the reason's own sentence for every readiness code", () => {
    // The two codes whose TOAST differs from their REASON: `competition_publish_validation_failed`
    // names the fields the server rejected, and `competition_invalid_transition` reports that the
    // status moved underneath the caller. Both are asserted on their own below.
    const TOAST_DIFFERS_FROM_REASON = [
      "competition_publish_validation_failed",
      "competition_invalid_transition",
    ];
    for (const code of BLOCKER_CODES.filter((c) => !TOAST_DIFFERS_FROM_REASON.includes(c))) {
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

  it("says the status moved underneath the caller, not the reason a disabled control carries", () => {
    // The CONTROL is disabled because the row is not a draft — a state. The TOAST fires because the
    // status changed between the readiness read and the click — an event. One sentence cannot carry
    // both, and the toast is the one the user sees after acting.
    expect(resolvePublishRefusalToastText("competition_invalid_transition")).not.toBe(
      getPublishBlockerReason("competition_invalid_transition").text,
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
      resolvePublishRefusalToastText("host_check_pending_other_draft", undefined, TITLE_OTHER),
      resolvePublishRefusalToastText("host_check_pending_other_draft"),
      resolvePublishRefusalToastText("host_check_contact_missing"),
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

describe("the publish control for a host check", () => {
  it("keeps Terbitkan when no host check is needed or the answer is unknown", () => {
    const publishNow = { label: "Terbitkan", pressable: true, note: null, tone: "info" };

    expect(describePublishControl(undefined)).toEqual(publishNow);
    expect(describePublishControl({ state: "not_needed" })).toEqual(publishNow);
  });

  it("asks for the host check with Kirim untuk diperiksa and says the wait", () => {
    expect(describePublishControl({ state: "needed" })).toEqual({
      label: "Kirim untuk diperiksa",
      pressable: true,
      note: `Kompetisi pertama Anda diperiksa staf sebelum tayang. ${WAIT_SENTENCE}`,
      tone: "info",
    });
  });

  it("drops pertama from the needed sentence for an account whose trust staff removed", () => {
    expect(describePublishControl({ state: "needed", trustRemoved: true })).toEqual({
      label: "Kirim untuk diperiksa",
      pressable: true,
      note: "Kompetisi Anda diperiksa staf dulu sebelum tayang. Perkiraan 1x24 jam pada hari kerja.",
      tone: "info",
    });
  });

  it("shuts the control while this draft waits", () => {
    expect(describePublishControl({ state: "pending" })).toEqual({
      label: "Sedang diperiksa",
      pressable: false,
      note: `Staf Lombakita sedang memeriksa kompetisi ini. ${WAIT_SENTENCE}`,
      tone: "info",
    });
  });

  it("shuts the control while another draft waits, naming it only when the server named it", () => {
    expect(
      describePublishControl({ state: "pending_other_draft", competitionTitle: TITLE_OTHER }),
    ).toEqual({
      label: "Kirim untuk diperiksa",
      pressable: false,
      note: TITLED_OTHER_DRAFT_SENTENCE,
      tone: "info",
    });
    expect(describePublishControl({ state: "pending_other_draft" })).toEqual({
      label: "Kirim untuk diperiksa",
      pressable: false,
      note: UNTITLED_OTHER_DRAFT_SENTENCE,
      tone: "info",
    });
  });

  it("gives the guideline text and the staff note of a turn-down, with one full stop after each", () => {
    const turnedDown = {
      label: "Kirim untuk diperiksa",
      pressable: true,
      note: `Belum dapat tayang. Pedoman: ${KONTAK_TEXT} Catatan staf: Nomor kontak tidak aktif. Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.`,
      tone: "warning",
    };

    expect(
      describePublishControl({
        state: "turned_down",
        guidelineItem: "kontak-nyata",
        note: "Nomor kontak tidak aktif",
      }),
    ).toEqual(turnedDown);
    expect(
      describePublishControl({
        state: "turned_down",
        guidelineItem: "kontak-nyata",
        note: "Nomor kontak tidak aktif.",
      }),
    ).toEqual(turnedDown);
  });

  it("names the press refusals of a host check", () => {
    expect(
      resolvePublishRefusalToastText("host_check_pending_other_draft", undefined, TITLE_OTHER),
    ).toBe(TITLED_OTHER_DRAFT_SENTENCE);
    expect(resolvePublishRefusalToastText("host_check_pending_other_draft")).toBe(
      UNTITLED_OTHER_DRAFT_SENTENCE,
    );
    expect(resolvePublishRefusalToastText("host_check_contact_missing")).toBe(
      "Lengkapi nama dan nomor ponsel di profil Anda sebelum mengirim kompetisi.",
    );
  });

  it("says a press that opened a host check was sent for checking", () => {
    expect(HOST_CHECK_SENT_TOAST_TEXT).toBe(
      "Kompetisi dikirim untuk diperiksa. Perkiraan 1x24 jam pada hari kerja.",
    );
  });
});
