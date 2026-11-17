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

const FEE_SECTION_PARAGRAPHS = [
  "Kompetisi bisa gratis atau memungut biaya pendaftaran. Bila memungut biaya, biaya itu ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  "Kamu membayar langsung kepada penyelenggara, bukan kepada Lombakita. Saat ini pembayaran lewat transfer manual atau QRIS, dengan bukti pembayaran yang diperiksa penyelenggara. Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran, dan tidak memungut biaya dari peserta. Pembayaran online melalui penyedia pembayaran berlisensi sedang direncanakan.",
  "Untuk penyelenggara: rincian biaya layanan Lombakita yang berlaku saat itu ditampilkan kepada penyelenggara dan harus disetujui saat ia mengaktifkan pendaftaran berbayar.",
];

const PARAGRAPHS = [
  "Lombakita adalah platform untuk menemukan dan mendaftar kompetisi di Indonesia. Penyelenggara menerbitkan kompetisinya di sini, dan peserta mendaftar tanpa pindah situs.",
  "Untuk peserta: jelajahi kompetisi menurut kategori, penyelenggara, dan tenggat, simpan yang menarik, lalu daftar langsung dari halaman kompetisi, sebagai individu atau tim.",
  "Untuk penyelenggara: institusi membuat ruang kerja, menerbitkan kompetisi, dan mengelola pendaftar serta hasilnya. Lombakita tidak menilai peserta dan tidak ikut menentukan pemenang.",
  ...FEE_SECTION_PARAGRAPHS,
  "Pertanyaan tentang jumlah biaya, bukti pembayaran, jadwal, penilaian, dan hasil lomba dijawab oleh penyelenggara kompetisi yang bersangkutan.",
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

// The page may state only what stays true under any platform fee rule, so a first fee rule cannot
// make it false. The guard is the closed ALLOWED_FEE_SENTENCES list below: a blocklist of
// phrasings lets any rewording through. These patterns only name the claim in the failure message
// when an unlisted sentence matches one, and each is paired with a sentence it must match, which
// proves the pattern is live and not a regex that can never fire.
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

// Every sentence on the page that mentions money, and nothing else. Adding a fee sentence to the
// page fails the guard until it is added here on purpose.
const ALLOWED_FEE_SENTENCES = [
  "Biaya dan pembayaran",
  "Kompetisi bisa gratis atau memungut biaya pendaftaran.",
  "Bila memungut biaya, biaya itu ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  "Kamu membayar langsung kepada penyelenggara, bukan kepada Lombakita.",
  "Saat ini pembayaran lewat transfer manual atau QRIS, dengan bukti pembayaran yang diperiksa penyelenggara.",
  "Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran, dan tidak memungut biaya dari peserta.",
  "Pembayaran online melalui penyedia pembayaran berlisensi sedang direncanakan.",
  "Untuk penyelenggara: rincian biaya layanan Lombakita yang berlaku saat itu ditampilkan kepada penyelenggara dan harus disetujui saat ia mengaktifkan pendaftaran berbayar.",
  "Biaya pendaftaran yang sudah dibayarkan tidak dikembalikan atas permintaan peserta sendiri.",
  "Pertanyaan tentang jumlah biaya, bukti pembayaran, jadwal, penilaian, dan hasil lomba dijawab oleh penyelenggara kompetisi yang bersangkutan.",
];

// Matched as a substring so inflections such as "pembayaran" and "biayanya" count as fee words.
const FEE_WORDS = /gratis|biaya|bayar|membayar|dibayarkan|memungut|berbayar/i;

function textOfMarkup(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// One line per heading, paragraph and list item. A heading has no closing period, so without the
// line breaks it would run into the first sentence after it.
function renderedTextOf(markup: string): string {
  const blocks = markup.split(/<\/(?:h1|h2|p|li)>/);
  return blocks.map(textOfMarkup).filter(Boolean).join("\n");
}

function paragraphsUnderHeading(markup: string, heading: string): string[] {
  const afterHeading = markup.split(`<h2 class="section-title">${heading}</h2>`)[1] ?? "";
  const section = afterHeading.split("<h2")[0] ?? "";
  const paragraphs = [...section.matchAll(/<p>(.*?)<\/p>/g)];
  return paragraphs.map(([, inner]) => textOfMarkup(inner ?? ""));
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function describeUnlistedFeeSentence(sentence: string): string {
  const knownClaim = FALSE_FEE_CLAIMS.find(({ pattern }) => pattern.test(sentence));
  const reason = knownClaim
    ? `it claims ${knownClaim.claim}`
    : "it is not in ALLOWED_FEE_SENTENCES";
  return `Fee sentence "${sentence}": ${reason}`;
}

function assertEveryFeeSentenceIsAllowed(text: string): void {
  const unlisted = sentencesOf(text).filter(
    (sentence) => FEE_WORDS.test(sentence) && !ALLOWED_FEE_SENTENCES.includes(sentence),
  );
  if (unlisted.length > 0) {
    throw new Error(unlisted.map(describeUnlistedFeeSentence).join("\n"));
  }
}

const html = renderToStaticMarkup(AboutPage());
const pageText = renderedTextOf(html);

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

  it("carries exactly the expected paragraphs in the fee section", () => {
    expect(paragraphsUnderHeading(html, "Biaya dan pembayaran")).toEqual(FEE_SECTION_PARAGRAPHS);
  });

  it("states no fee sentence that is missing from the allowlist", () => {
    expect(() => assertEveryFeeSentenceIsAllowed(pageText)).not.toThrow();
  });

  it("names a plain extra fee sentence when it is appended to the page", () => {
    const extraSentence = "Mengikuti kompetisi di Lombakita tidak dikenakan biaya.";

    expect(() => assertEveryFeeSentenceIsAllowed(`${pageText} ${extraSentence}`)).toThrow(
      `Fee sentence "${extraSentence}": it is not in ALLOWED_FEE_SENTENCES`,
    );
  });

  it.each(FALSE_FEE_CLAIMS)(
    "names the claim $claim when its example is appended",
    ({ claim, example }) => {
      expect(() => assertEveryFeeSentenceIsAllowed(`${pageText} ${example}`)).toThrow(
        `Fee sentence "${example}": it claims ${claim}`,
      );
    },
  );

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
