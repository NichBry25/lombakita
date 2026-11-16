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
];

const PARAGRAPHS = [
  "Lombakita adalah platform untuk menemukan dan mendaftar kompetisi di Indonesia. Penyelenggara menerbitkan kompetisinya di sini, dan peserta mendaftar tanpa pindah situs.",
  "Untuk peserta: jelajahi kompetisi menurut kategori, penyelenggara, dan tenggat, simpan yang menarik, lalu daftar langsung dari halaman kompetisi, sebagai individu atau tim.",
  "Untuk penyelenggara: institusi membuat ruang kerja, menerbitkan kompetisi, dan mengelola pendaftar serta hasilnya. Lombakita tidak menilai peserta dan tidak ikut menentukan pemenang.",
  "Sebagian kompetisi gratis, sebagian memungut biaya pendaftaran. Biaya itu ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  "Kamu membayar langsung kepada penyelenggara, bukan kepada Lombakita. Saat ini pembayaran lewat transfer manual atau QRIS, dengan bukti pembayaran yang diperiksa penyelenggara. Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran, dan tidak memungut biaya dari peserta. Pembayaran online melalui penyedia pembayaran berlisensi sedang direncanakan.",
  "Untuk penyelenggara: bila ada biaya layanan Lombakita, rinciannya ditampilkan kepada penyelenggara dan harus disetujui sebelum pendaftaran berbayar diaktifkan.",
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

// The fee section may state only what stays true under any platform fee rule, so a first fee rule
// cannot make the page false. Each pattern is paired with a sentence it must match, which proves
// the pattern is live and not a regex that can never fire.
const FALSE_FEE_CLAIMS = [
  {
    claim: "that all competitions are free",
    pattern: /\b(?:semua|seluruh) kompetisi[^.]*\bgratis/i,
    example: "Saat ini semua kompetisi di Lombakita gratis untuk diikuti.",
  },
  {
    claim: "that paid registration is unavailable",
    pattern:
      /\b(?:belum|tidak) ada (?:pendaftaran|kompetisi) berbayar|\b(?:pendaftaran|kompetisi) berbayar (?:belum|tidak) (?:tersedia|ada|dibuka)/i,
    example: "Pendaftaran berbayar belum tersedia dan akan dibuka kemudian.",
  },
  {
    claim: "that Lombakita charges organisers nothing",
    pattern: /tidak memungut biaya dari[^.]*penyelenggara/i,
    example: "Lombakita tidak memungut biaya dari peserta maupun penyelenggara.",
  },
  {
    claim: "that Lombakita is free for organisers",
    pattern: /\b(?:gratis|tanpa biaya) (?:untuk|bagi) penyelenggara/i,
    example: "Menerbitkan kompetisi gratis bagi penyelenggara.",
  },
];

// The facts that stay true at a 0% fee and at a non-zero fee, one case each.
const FEE_FACTS = [
  {
    fact: "some competitions are free and some charge a registration fee",
    text: "Sebagian kompetisi gratis, sebagian memungut biaya pendaftaran.",
  },
  {
    fact: "the organiser sets the fee and the competition page shows it before registering",
    text: "Biaya itu ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  },
  {
    fact: "participants pay the organiser directly, not Lombakita",
    text: "Kamu membayar langsung kepada penyelenggara, bukan kepada Lombakita.",
  },
  {
    fact: "payment is by manual transfer or QRIS, with proof checked by the organiser",
    text: "lewat transfer manual atau QRIS, dengan bukti pembayaran yang diperiksa penyelenggara.",
  },
  {
    fact: "Lombakita does not hold, store or pass on registration money",
    text: "Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran",
  },
  {
    fact: "Lombakita charges participants nothing",
    text: "tidak memungut biaya dari peserta.",
  },
  {
    fact: "an organiser sees and approves any Lombakita service fee before turning on paid registration",
    text: "bila ada biaya layanan Lombakita, rinciannya ditampilkan kepada penyelenggara dan harus disetujui sebelum pendaftaran berbayar diaktifkan.",
  },
  {
    fact: "online payment through a licensed provider is planned",
    text: "Pembayaran online melalui penyedia pembayaran berlisensi sedang direncanakan.",
  },
];

const html = renderToStaticMarkup(AboutPage());
const pageText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

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

  it("sets every ordered list in the prose-list class so its numerals show", () => {
    const openingTags = html.match(/<ol[^>]*>/g) ?? [];

    expect(openingTags.length).toBeGreaterThan(0);
    for (const tag of openingTags) {
      expect(tag).toMatch(/class="[^"]*\bprose-list\b[^"]*"/);
    }
  });

  it.each(FALSE_FEE_CLAIMS)("has a live pattern for the claim $claim", ({ pattern, example }) => {
    expect(example).toMatch(pattern);
  });

  it.each(FALSE_FEE_CLAIMS)("does not claim $claim", ({ pattern }) => {
    expect(pageText).not.toMatch(pattern);
  });

  it.each(FEE_FACTS)("states that $fact", ({ text }) => {
    expect(pageText).toContain(text);
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

  it("closes the help section with one sentence that names the support email as a link", () => {
    expect(html).toContain(
      `<p>Ada pertanyaan? Hubungi kami di <a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a>.</p>`,
    );
    expect(html.split(COMPANY.supportEmail)).toHaveLength(3);
  });

  it("lists no company identity and no mobile number", () => {
    expect(html).not.toContain("<dt>");
    expect(html).not.toContain("tel:");
    expect(html).not.toMatch(/(?:\+62|\b0)8\d{1,2}[\s-]?\d{3,4}[\s-]?\d{3,4}/);
    expect(html).not.toMatch(/\b\d{13}\b/);
  });

  it("declares its metadata", () => {
    expect(metadata.title).toBe("Tentang · Lombakita");
    expect(metadata.description).toBe("Apa itu Lombakita, cara mendaftar kompetisi, dan biayanya.");
    expect(metadata.robots).toMatchObject({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("/tentang");
  });
});
