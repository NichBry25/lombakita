// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render a real <a> so renderToStaticMarkup can assert href attributes without a router context.
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

import AboutPage, { metadata } from "@/app/tentang/page";
import { COMPANY } from "@/config/company";

// The copy on this page is owner-ruled and byte-exact, and nothing downstream verifies it. Each
// string is asserted as its own case so a removed or reworded sentence names itself in the failure.
// `"` renders as `&quot;` and `&` as `&amp;` in static markup, so the expected strings carry those.
const HEADINGS = [
  "Layanan kami",
  "Cara mendaftar kompetisi",
  "Cara menerbitkan kompetisi",
  "Biaya dan pembayaran",
  "Pembatalan dan pengembalian dana",
  "Bantuan",
  "Identitas badan usaha",
];

const PARAGRAPHS = [
  "Lombakita adalah platform untuk menemukan dan mendaftar kompetisi di Indonesia. Penyelenggara menerbitkan kompetisinya di sini, dan peserta mendaftar tanpa pindah situs.",
  "Untuk peserta: jelajahi kompetisi menurut kategori, penyelenggara, dan tenggat, simpan yang menarik, lalu daftar langsung dari halaman kompetisi, sebagai individu atau tim.",
  "Untuk penyelenggara: institusi membuat ruang kerja, menerbitkan kompetisi, dan mengelola pendaftar serta hasilnya. Lombakita tidak menilai peserta dan tidak ikut menentukan pemenang.",
  "Saat ini semua kompetisi di Lombakita gratis untuk diikuti, dan Lombakita tidak memungut biaya dari peserta maupun penyelenggara.",
  "Pendaftaran berbayar belum tersedia dan akan dibuka kemudian. Bila sudah dibuka, biaya pendaftaran ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  "Biaya dibayarkan kepada penyelenggara, bukan kepada Lombakita. Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran. Saat ini pembayaran dilakukan lewat transfer manual ke rekening penyelenggara, dengan bukti transfer yang diperiksa penyelenggara. Pembayaran online melalui penyedia pembayaran berlisensi akan menyusul. Pembayaran online segera hadir.",
  "Pertanyaan tentang jumlah biaya, bukti transfer, jadwal, penilaian, dan hasil lomba dijawab oleh penyelenggara kompetisi yang bersangkutan.",
];

const LIST_ITEMS = [
  "Buka halaman kompetisi dan baca persyaratannya.",
  "Masuk, atau buat akun sebagai peserta.",
  "Tekan &quot;Daftar kompetisi&quot;, lalu daftar sebagai individu atau buat tim.",
  "Konfirmasi pendaftaran dikirim ke emailmu.",
  "Buat akun sebagai penyelenggara, lalu buat ruang kerja institusi.",
  "Selesaikan verifikasi penyelenggara.",
  "Buat draf kompetisi, lengkapi detailnya, lalu terbitkan.",
];

const html = renderToStaticMarkup(AboutPage());

describe("AboutPage", () => {
  it("renders the h1", () => {
    expect(html).toContain("<h1>Tentang Lombakita</h1>");
  });

  it.each(HEADINGS)("renders the heading %s", (heading) => {
    expect(html).toContain(`<h2 class="section-title">${heading}</h2>`);
  });

  it.each(PARAGRAPHS)("renders the paragraph %s", (paragraph) => {
    expect(html).toContain(`<p>${paragraph}</p>`);
  });

  it.each(LIST_ITEMS)("renders the list item %s", (item) => {
    expect(html).toContain(`<li>${item}</li>`);
  });

  it("states that online payment is coming, as its own sentence", () => {
    expect(html).toContain("Pembayaran online segera hadir.");
  });

  it("links the terms from the refund paragraph and cites clauses 5 to 7", () => {
    expect(html).toContain(
      "Ketentuan lengkap tentang pembatalan kompetisi oleh penyelenggara dan pengembalian dana ada di",
    );
    expect(html).toContain('<a href="/syarat-ketentuan">Syarat &amp; Ketentuan</a>');
    expect(html).toContain(", bagian 5 sampai 7.");
    expect(html).toContain(
      "Biaya pendaftaran yang sudah dibayarkan tidak dikembalikan atas permintaan peserta sendiri.",
    );
  });

  it("closes the help paragraph with the email and telephone from COMPANY as links", () => {
    expect(html).toContain(
      "Untuk masalah akun, penangguhan akun, data pribadi, atau bila penyelenggara tidak dapat dihubungi, kirim email ke",
    );
    expect(html).toContain(
      `<a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a> atau hubungi`,
    );
    expect(html).toContain(`<a href="${COMPANY.phone.href}">${COMPANY.phone.display}</a>.</p>`);
  });

  it("renders the five identity values from COMPANY", () => {
    expect(html).toContain(`<dt>Nama badan usaha</dt><dd>${COMPANY.legalName}</dd>`);
    expect(html).toContain(`<dt>Alamat terdaftar</dt><dd>${COMPANY.address}</dd>`);
    expect(html).toContain(`<dt>NIB</dt><dd class="data-text">${COMPANY.nib}</dd>`);
    expect(html).toContain(
      `<dt>Email</dt><dd><a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a></dd>`,
    );
    expect(html).toContain(
      `<dt>Telepon</dt><dd><a href="${COMPANY.phone.href}">${COMPANY.phone.display}</a></dd>`,
    );
  });

  it("links to the contact page", () => {
    expect(html).toContain('<a href="/kontak">Lihat halaman kontak</a>');
  });

  it("declares its metadata", () => {
    expect(metadata.title).toBe("Tentang · Lombakita");
    expect(metadata.description).toBe(
      "Apa itu Lombakita, cara mendaftar kompetisi, biaya, dan identitas badan usaha yang mengoperasikannya.",
    );
    expect(metadata.robots).toMatchObject({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("/tentang");
  });
});
