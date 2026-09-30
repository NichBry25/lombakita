// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

import PrivacyPage from "@/app/kebijakan-privasi/page";
import { COMPANY, LEGAL_DOCUMENT } from "@/config/company";

function renderPage(): string {
  return renderToStaticMarkup(PrivacyPage());
}

/**
 * The `<li>` texts of the first list in the document at or after `lead`.
 *
 * Returns the items rather than the markup so an assertion can say what the list must contain
 * instead of what substring must appear: an item that reappears anywhere in the list fails the
 * comparison, where a `toContain` on the whole list would still pass with a third item inserted.
 */
function listItemsAfter(html: string, lead: string): string[] {
  const leadAt = html.indexOf(lead);
  expect(leadAt, `the document does not contain ${lead}`).toBeGreaterThanOrEqual(0);

  const listStart = html.indexOf('<ul class="document-list">', leadAt);
  const listEnd = html.indexOf("</ul>", listStart);
  const list = html.slice(listStart, listEnd);

  // A capture that did not participate degrades to an empty item, which `toEqual` then rejects
  // loudly, rather than to a silently shifted list.
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1] ?? "");
}

describe("PrivacyPage", () => {
  it("renders the company facts and document version this page reads", () => {
    const html = renderPage();

    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.address);
    expect(html).toContain(COMPANY.supportEmail);
    expect(html).toContain(`mailto:${COMPANY.supportEmail}`);
    expect(html).toContain(LEGAL_DOCUMENT.version);
    expect(html).toContain(LEGAL_DOCUMENT.effectiveDateLabel);
    expect(html).toContain(`Diperbarui ${LEGAL_DOCUMENT.updatedDateLabel}`);
  });

  // Pinned to the literals rather than to `LEGAL_DOCUMENT`, because this is the pair of facts the
  // reader is being asked to rely on: the text they are reading is version 1.1, effective since
  // 4 September 2026, last changed 30 September 2026. Reading the constant back would let a bump
  // ship with no test noticing the page changed underneath a standing version number.
  it("states the version and both dates as published", () => {
    const html = renderPage();

    expect(html).toContain("<span>Versi 1.1</span>");
    expect(html).toContain("<span>Berlaku sejak 4 September 2026</span>");
    expect(html).toContain("<span>Diperbarui 30 September 2026</span>");
  });

  it("never renders an NPWP, by name or by shape", () => {
    const html = renderPage();

    expect(html).not.toMatch(/npwp/i);
    expect(html).not.toMatch(/\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/);
  });

  describe("§5, what no scheduled job deletes", () => {
    // The list the de-identification service's behaviour forces. Institution files left this list
    // because they are not the account's to delete, and recruiter verification documents stayed
    // as the one institution-owned exception, so the reader is not told a file survives forever
    // when the institution that owns it can be erased with the account.
    it("lists exactly the files that survive an account deletion", () => {
      const html = renderPage();

      expect(listItemsAfter(html, "<strong>Tidak dihapus otomatis.</strong>")).toEqual([
        "foto profil, sampul profil, CV, dan berkas sertifikasi;",
        "dokumen verifikasi rekruter.",
      ]);
    });

    it("no longer claims institution logo, cover and QRIS sit in the account's undying files", () => {
      const html = renderPage();

      expect(html).not.toContain("logo dan sampul institusi serta gambar QRIS;");
    });

    it("no longer lists institution verification documents alongside the account's own", () => {
      const html = renderPage();

      // Anchored on the closing tag: §4 legitimately keeps the same words as its own bullet, and
      // only the retired §5 item ended in a period.
      expect(html).not.toContain("dokumen verifikasi institusi dan dokumen verifikasi rekruter.<");
    });

    it("says institution files belong to the institution and are erased with a personal one", () => {
      const html = renderPage();

      expect(html).toContain(
        "<strong>Berkas institusi.</strong> Logo, sampul, gambar QRIS, dan dokumen verifikasi " +
          "sebuah institusi adalah milik institusi itu, bukan milik satu akun. Berkas ini " +
          "tersimpan selama institusinya ada. Untuk institusi pribadi, berkas ini dihapus bersama " +
          "data akun pemiliknya, kecuali gambar QRIS yang masih dirujuk catatan pembayaran.",
      );
    });

    it("discloses the change history that can outlive a deletion", () => {
      const html = renderPage();

      expect(html).toContain(
        "<strong>Cadangan.</strong> Basis data kami menyimpan riwayat perubahan selama 6 jam " +
          "untuk memulihkan layanan dari kesalahan atau gangguan. Data yang sudah dihapus dapat " +
          "tetap ada dalam riwayat itu sampai jangka waktu tersebut berlalu. Kami tidak memakai " +
          "riwayat ini untuk tujuan lain.",
      );
    });
  });

  describe("§9, what asking us to delete your account does", () => {
    it("names the three states that must be resolved before an account can be erased", () => {
      const html = renderPage();

      expect(html).toContain(
        "Jika Anda pemilik terakhir sebuah institusi, kepemilikannya perlu dipindahkan terlebih " +
          "dahulu. Jika Anda kapten sebuah tim yang masih dibentuk, tim itu perlu didaftarkan " +
          "atau dibubarkan terlebih dahulu. Jika institusi pribadi Anda masih memiliki kompetisi " +
          "yang sedang terbit, kompetisi itu kami tutup dengan semestinya lebih dulu agar peserta " +
          "tidak dirugikan, sehingga permintaan Anda dapat memerlukan waktu.",
      );
    });

    it("says what is erased and what is kept without identifying data", () => {
      const html = renderPage();

      expect(html).toContain(
        "Jika kami menghapus akun Anda, nama, email, profil, dan semua berkas Anda dihapus, dan " +
          "akun tidak dapat digunakan untuk masuk lagi. Catatan yang juga menyangkut orang lain " +
          "tetap disimpan, tetapi tanpa data yang mengidentifikasi Anda: pendaftaran dan hasil " +
          "lomba, keanggotaan tim, karya yang diunggah anggota tim lain, catatan keuangan " +
          "termasuk bukti transfer, dan catatan audit keamanan.",
      );
    });

    it("keeps the email link and the channel it is asked from", () => {
      const html = renderPage();

      expect(html).toContain(
        "meminta penghapusan akun, hubungi " +
          `<a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a> dari alamat ` +
          "email akun Anda, agar kami dapat memastikan permintaan itu datang dari pemilik akun.",
      );
    });

    it("states the absence of a self-service delete without promising a deadline", () => {
      const html = renderPage();

      expect(html).toContain(
        "Kami menyampaikan apa adanya: belum ada tombol di halaman akun untuk menghapus akun " +
          "sendiri. Permintaan diproses oleh tim kami satu per satu, dan kami akan memberitahu " +
          "Anda apa yang kami lakukan.",
      );
      // The retired sentence. It promised nothing the platform enforces, so it must not come back
      // in this or any other clause.
      expect(html).not.toContain("tidak menjanjikan batas waktu");
    });
  });
});
