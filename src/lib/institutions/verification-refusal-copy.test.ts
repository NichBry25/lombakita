// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERIFICATION_REFUSAL_COPY,
  resolveVerificationRefusalMessage,
} from "@/lib/institutions/verification-refusal-copy";

// The English prose the server puts in the envelope for this refusal
// (operator-institution-conflict.ts). Duplicated rather than imported: that module is server-only.
const SERVER_ENGLISH =
  "A platform-ops account cannot decide the verification of an institution it has filed for, been invited to, or held any membership in";

describe("resolveVerificationRefusalMessage", () => {
  it("translates the DEC-0220 refusal instead of relaying the server's English", () => {
    const message = resolveVerificationRefusalMessage(
      { code: "operator_actor_conflicted", message: SERVER_ENGLISH },
      "Gagal.",
    );

    expect(message).toBe(VERIFICATION_REFUSAL_COPY.operator_actor_conflicted);
    expect(message).toBe(
      "Anda tidak dapat memutuskan verifikasi institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
    );
    expect(message).not.toBe(SERVER_ENGLISH);
    expect(message).not.toMatch(/platform-ops|cannot decide/i);
  });

  it("falls back instead of relaying the server's message for a code it has no copy for", () => {
    expect(resolveVerificationRefusalMessage({ code: "unmapped_refusal_code" }, "Gagal.")).toBe(
      "Gagal.",
    );
  });

  it("falls back when the envelope carries neither a known code nor a message", () => {
    expect(resolveVerificationRefusalMessage(undefined, "Gagal.")).toBe("Gagal.");
    expect(resolveVerificationRefusalMessage({ code: "x" }, "Gagal.")).toBe("Gagal.");
  });

  it("resolves a closure refusal by its cause", () => {
    const staffLine =
      "Centang ruang kerja ini dicabut atau ditolak staf, jadi centang hanya bisa didapat lagi lewat dokumen.";
    const automaticLine =
      "Centang ruang kerja ini hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu, jadi centang hanya bisa didapat lagi lewat dokumen.";

    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_tick_closed_needs_documents", details: { cause: "staff" } },
        "Gagal.",
      ),
    ).toBe(staffLine);
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_tick_closed_needs_documents", details: { cause: "automatic" } },
        "Gagal.",
      ),
    ).toBe(automaticLine);
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_tick_closed_needs_documents" },
        "Gagal.",
      ),
    ).toBe("Gagal.");
  });

  it("resolves the Path A closure refusal by its cause and the other new refusals by code", () => {
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_tick_path_a_closed", details: { cause: "staff" } },
        "Gagal.",
      ),
    ).toBe(VERIFICATION_REFUSAL_COPY["institution_tick_path_a_closed:staff"]);
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_tick_live_paid_competition" },
        "Gagal.",
      ),
    ).toBe(
      "Ruang kerja ini punya kompetisi berbayar yang sedang tayang, jadi centang hanya bisa didapat lagi lewat dokumen agar staf memeriksa namanya.",
    );
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_name_proof_needs_documents" },
        "Gagal.",
      ),
    ).toBe(
      "Selama bukti nama berjalan, nama ruang kerja hanya dapat dibuktikan lewat dokumen. Kirim dokumen sebelum batas waktunya.",
    );
  });
});

describe("the name check refusal", () => {
  it("translates the reason-required refusal of a name check", () => {
    expect(
      resolveVerificationRefusalMessage(
        { code: "institution_name_check_reason_required" },
        "Gagal.",
      ),
    ).toBe("Tulis alasan menerima nama ini, karena bukti nama sedang berjalan.");
  });
});

// The tick queue and the institutions page show these refusals, so both read the envelope through
// the helper. The call sites are counted, not just detected: the tick queue resolves every refusal
// in one function, and the institutions page has three (the transition, the reject form and the
// rename). A file that went back to `error.message` at one of them would show the English again
// while a presence check stayed green.
const CALL_SITES: Array<{ path: string; expected: number }> = [
  { path: "src/components/admin/tick-queue.tsx", expected: 1 },
  { path: "src/app/admin/institutions/page.tsx", expected: 3 },
];

describe("the operator verification surfaces", () => {
  it.each(CALL_SITES)("$path resolves a refusal at exactly $expected call site(s)", (site) => {
    const source = readFileSync(join(process.cwd(), site.path), "utf8");
    const callSites = source.split("resolveVerificationRefusalMessage(").length - 1;

    expect(callSites).toBe(site.expected);
  });
});
