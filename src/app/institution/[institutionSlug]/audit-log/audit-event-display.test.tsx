// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { auditEventDataEntries, auditEventName, auditEventSummary } from "./audit-event-display";

const summaryText = (action: string, metadata: unknown): string =>
  renderToStaticMarkup(<>{auditEventSummary(action, metadata)}</>).replace(/<[^>]+>/g, "");

describe("audit event names", () => {
  it.each([
    ["member.role_changed", "Peran anggota diubah"],
    ["member.removed", "Anggota dihapus"],
    ["result_published", "Hasil dipublikasikan"],
    ["result_unpublished", "Publikasi hasil dibatalkan"],
    ["review_status_changed", "Tinjauan diperbarui"],
    ["submission.file_accessed", "Berkas karya dibuka"],
    ["payment_proof.file_accessed", "Bukti pembayaran dibuka"],
    ["document_request.created", "Permintaan dokumen dibuat"],
    ["document_request.reviewed", "Permintaan dokumen ditinjau"],
    ["document_request.deadline_extended", "Tenggat permintaan diperpanjang"],
    ["document_request.cancelled", "Permintaan dokumen dibatalkan"],
    ["document_request.file_accessed", "Berkas permintaan dokumen dibuka"],
  ])("names %s in Indonesian", (action, name) => {
    expect(auditEventName(action)).toBe(name);
  });

  it("keeps the English reading of an action it has no name for", () => {
    expect(auditEventName("institution.archived")).toBe("Institution archived");
  });
});

describe("audit event summaries", () => {
  it("reads a role change with both role names", () => {
    expect(
      summaryText("member.role_changed", { from: "institution_staff", to: "institution_owner" }),
    ).toBe("Staf menjadi Pemilik");
  });

  it("reads the role a removed member held", () => {
    expect(summaryText("member.removed", { removedRole: "institution_staff" })).toBe(
      "Peran saat dihapus: Staf",
    );
  });

  it("reads the label of a published result and leaves the registration type out", () => {
    expect(
      summaryText("result_published", { resultLabel: "Juara 2", registrationType: "team" }),
    ).toBe("Hasil: Juara 2");
  });

  it("reads the new review status with the label the site already shows", () => {
    expect(summaryText("review_status_changed", { newStatus: "shortlisted" })).toBe(
      "Status baru: Masuk daftar pendek",
    );
  });

  it("says the notes were updated when a review stored no new status", () => {
    expect(summaryText("review_status_changed", { newStatus: null })).toBe("Catatan diperbarui");
  });

  it("reads the file name and version of an opened submission", () => {
    expect(
      summaryText("submission.file_accessed", { fileName: "karya-andi.pdf", version: 2 }),
    ).toBe("karya-andi.pdf, versi 2");
  });

  it("counts a payment proof attempt from one", () => {
    expect(summaryText("payment_proof.file_accessed", { attempt: 0 })).toBe("Percobaan 1");
  });

  it("reads the title of a created document request", () => {
    expect(summaryText("document_request.created", { title: "Kartu pelajar", dueAt: "x" })).toBe(
      "Kartu pelajar",
    );
  });

  it("reads the verdict of a reviewed document request and never its note", () => {
    const accepted = summaryText("document_request.reviewed", { verdict: "accept" });
    const rejected = summaryText("document_request.reviewed", {
      verdict: "reject",
      note: "Fotonya buram",
    });
    expect(accepted).toBe("Diterima");
    expect(rejected).toBe("Ditolak");
  });

  it("reads the new deadline in the table date format", () => {
    const text = summaryText("document_request.deadline_extended", {
      dueAt: "2026-11-20T16:30:00.000Z",
    });
    expect(text).toBe("Tenggat baru 20 Nov 2026, 23.30");
  });

  it.each([
    ["result_unpublished", { competitionId: "c", registrationId: "r" }],
    ["document_request.cancelled", { requestId: "q" }],
    ["document_request.file_accessed", { fileId: "f", disposition: "inline" }],
    ["institution.archived", { anything: "x" }],
  ])("has no summary for %s", (action, metadata) => {
    expect(auditEventSummary(action, metadata)).toBeNull();
  });

  it("has no summary when the field the rule needs is missing", () => {
    expect(auditEventSummary("member.role_changed", { from: "institution_staff" })).toBeNull();
    expect(auditEventSummary("payment_proof.file_accessed", {})).toBeNull();
    expect(auditEventSummary("member.removed", null)).toBeNull();
  });
});

describe("audit event data", () => {
  it("lists every stored key with its full value", () => {
    const longNote = "x".repeat(300);
    const entries = auditEventDataEntries({
      verdict: "reject",
      reopened: false,
      note: longNote,
      version: 2,
      teamId: null,
    });

    expect(entries).toEqual([
      { key: "verdict", value: "reject" },
      { key: "reopened", value: "false" },
      { key: "note", value: longNote },
      { key: "version", value: "2" },
      { key: "teamId", value: "null" },
    ]);
  });

  it("lists nothing for a log entry that stored no data", () => {
    expect(auditEventDataEntries(null)).toEqual([]);
  });
});
