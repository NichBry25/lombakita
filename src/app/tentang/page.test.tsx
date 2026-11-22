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

// The page may state only what stays true under any platform fee rule, so a first fee rule cannot
// make it false. The guard is an exact pin of every block the page renders: a blocklist of
// phrasings lets any rewording through, so any added, removed, reworded or reordered block fails.
// The support email comes from COMPANY, as it does on the page.
const EXPECTED_PAGE_BLOCKS = [
  "Tentang Lombakita",
  "Lombakita adalah platform untuk menemukan dan mendaftar kompetisi di Indonesia. Penyelenggara menerbitkan kompetisinya di sini, dan peserta mendaftar tanpa pindah situs.",
  "Layanan kami",
  "Untuk peserta: jelajahi kompetisi menurut kategori, penyelenggara, dan tenggat, simpan yang menarik, lalu daftar langsung dari halaman kompetisi, sebagai individu atau tim.",
  "Untuk penyelenggara: institusi membuat ruang kerja, menerbitkan kompetisi, dan mengelola pendaftar serta hasilnya. Lombakita tidak menilai peserta dan tidak ikut menentukan pemenang.",
  "Cara mendaftar kompetisi",
  "Buka halaman kompetisi dan baca persyaratannya.",
  "Masuk, atau buat akun sebagai peserta.",
  'Tekan "Daftar kompetisi", lalu daftar sebagai individu atau buat tim.',
  "Konfirmasi pendaftaran dikirim ke emailmu.",
  "Cara menerbitkan kompetisi",
  "Buat akun sebagai penyelenggara, lalu buat ruang kerja institusi.",
  "Selesaikan verifikasi penyelenggara.",
  "Buat draf kompetisi, lengkapi detailnya, lalu terbitkan.",
  "Biaya dan pembayaran",
  "Kompetisi bisa gratis atau memungut biaya pendaftaran. Bila memungut biaya, biaya itu ditetapkan oleh penyelenggara dan tertera di halaman kompetisi sebelum kamu mendaftar.",
  "Kamu membayar langsung kepada penyelenggara, bukan kepada Lombakita. Saat ini pembayaran lewat transfer manual atau QRIS, dengan bukti pembayaran yang diperiksa penyelenggara. Lombakita tidak menampung, menyimpan, atau meneruskan uang pendaftaran, dan tidak memungut biaya dari peserta. Pembayaran online melalui penyedia pembayaran berlisensi sedang direncanakan.",
  "Untuk penyelenggara: saat mengaktifkan pendaftaran berbayar, penyelenggara melihat rincian biaya layanan Lombakita yang berlaku dan harus menyetujuinya.",
  "Pembatalan dan pengembalian dana",
  "Biaya pendaftaran yang sudah dibayarkan tidak dikembalikan atas permintaan peserta sendiri. Ketentuan lengkap tentang pembatalan kompetisi oleh penyelenggara dan pengembalian dana ada di Syarat & Ketentuan, bagian 5 sampai 7.",
  "Bantuan",
  "Pertanyaan tentang jumlah biaya, bukti pembayaran, jadwal, penilaian, dan hasil lomba dijawab oleh penyelenggara kompetisi yang bersangkutan.",
  `Ada pertanyaan? Hubungi kami di ${COMPANY.supportEmail}.`,
];

const BLOCK_TAGS = "h1|h2|h3|p|li";

function textOfMarkup(markup: string): string {
  return decodeQuotesAndAmpersands(markup.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeQuotesAndAmpersands(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function renderedBlocksOf(html: string): string[] {
  const blockPattern = new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>(.*?)</\\1>`, "gs");
  return [...html.matchAll(blockPattern)].map(([, , inner]) => textOfMarkup(inner ?? ""));
}

// Block and container tags become spaces so adjacent blocks do not run together. Inline tags such
// as <a> are removed without a space, so a link stays inside its sentence.
function visibleTextOf(html: string): string {
  const withBlockBreaks = html.replace(
    /<\/?(?:h1|h2|h3|p|li|ol|ul|section|div|main)\b[^>]*>/g,
    " ",
  );
  return textOfMarkup(withBlockBreaks);
}

function assertPageBlocksMatchExpected(html: string): void {
  const actual = renderedBlocksOf(html);
  const unexpected = actual.filter((block) => !EXPECTED_PAGE_BLOCKS.includes(block));
  const missing = EXPECTED_PAGE_BLOCKS.filter((block) => !actual.includes(block));
  const problems = [
    ...unexpected.map((block) => `Unexpected block: "${block}"`),
    ...missing.map((block) => `Missing block: "${block}"`),
  ];
  const sameBlocksInSameOrder =
    actual.length === EXPECTED_PAGE_BLOCKS.length &&
    actual.every((block, index) => block === EXPECTED_PAGE_BLOCKS[index]);
  if (problems.length === 0 && !sameBlocksInSameOrder) {
    problems.push("Blocks differ in count or order from EXPECTED_PAGE_BLOCKS");
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
}

function assertVisibleTextMatchesExpected(html: string): void {
  const actual = visibleTextOf(html);
  const expected = EXPECTED_PAGE_BLOCKS.join(" ");
  if (actual !== expected) {
    throw new Error(`Visible text differs from EXPECTED_PAGE_BLOCKS.\nActual: ${actual}`);
  }
}

function insertBefore(html: string, marker: string, insertion: string): string {
  const position = html.lastIndexOf(marker);
  expect(position).toBeGreaterThanOrEqual(0);
  return html.slice(0, position) + insertion + html.slice(position);
}

const html = renderToStaticMarkup(AboutPage());

describe("AboutPage", () => {
  it("renders exactly the expected blocks, in order", () => {
    expect(() => assertPageBlocksMatchExpected(html)).not.toThrow();
  });

  it("renders no visible text outside the expected blocks", () => {
    expect(() => assertVisibleTextMatchesExpected(html)).not.toThrow();
  });

  it("names an extra paragraph appended inside the last section", () => {
    const extraSentence = "Lombakita tidak mengenakan tarif kepada penyelenggara.";
    const withExtraParagraph = insertBefore(html, "</section>", `<p>${extraSentence}</p>`);

    expect(withExtraParagraph).not.toBe(html);
    expect(() => assertPageBlocksMatchExpected(withExtraParagraph)).toThrow(
      `Unexpected block: "${extraSentence}"`,
    );
  });

  it("fails when a block is missing", () => {
    const withoutBlock = html.replace("<li>Selesaikan verifikasi penyelenggara.</li>", "");

    expect(withoutBlock).not.toBe(html);
    expect(() => assertPageBlocksMatchExpected(withoutBlock)).toThrow(
      'Missing block: "Selesaikan verifikasi penyelenggara."',
    );
  });

  it("fails when two blocks swap places", () => {
    const first = "<li>Masuk, atau buat akun sebagai peserta.</li>";
    const second = "<li>Konfirmasi pendaftaran dikirim ke emailmu.</li>";
    const swapped = html.replace(first, "@@").replace(second, first).replace("@@", second);

    expect(swapped).not.toBe(html);
    expect(() => assertPageBlocksMatchExpected(swapped)).toThrow("Blocks differ in count or order");
  });

  it("fails on visible text placed outside the blocks", () => {
    const extraText = "Semua kompetisi bebas dari pungutan.";
    const withStrayText = insertBefore(html, "</div>", extraText);

    expect(withStrayText).not.toBe(html);
    expect(() => assertPageBlocksMatchExpected(withStrayText)).not.toThrow();
    expect(() => assertVisibleTextMatchesExpected(withStrayText)).toThrow(extraText);
  });

  it("sets every ordered list in the prose-list class so its numerals show", () => {
    const openingTags = html.match(/<ol[^>]*>/g) ?? [];

    expect(openingTags.length).toBeGreaterThan(0);
    for (const tag of openingTags) {
      expect(tag).toMatch(/class="[^"]*\bprose-list\b[^"]*"/);
    }
  });

  it("links the terms from the refund paragraph", () => {
    expect(html).toContain('<a href="/syarat-ketentuan">Syarat &amp; Ketentuan</a>');
  });

  it("links the support email once as a mailto link and once as its text", () => {
    expect(html).toContain(`<a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a>`);
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
