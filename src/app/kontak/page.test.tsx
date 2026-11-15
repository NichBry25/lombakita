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

import ContactPage, { metadata } from "@/app/kontak/page";
import { COMPANY } from "@/config/company";

// The support email is the one fact this page states, and it is read from the single source of
// truth. This pins the RENDERED page, not the module — a future page rewrite that stops reading
// COMPANY would fail here even if the module itself stayed correct.
describe("ContactPage", () => {
  it("renders the support email, once, as a mailto link", () => {
    const html = renderToStaticMarkup(ContactPage());

    expect(html).toContain(`<dt>Email</dt>`);
    expect(html).toContain(`<a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a>`);
    expect(html.split(COMPANY.supportEmail)).toHaveLength(3);
  });

  // The page names no company name, address, telephone number or registration number: no row for
  // them, and no mobile-number or 13-digit shape left anywhere in the markup.
  it("renders no company identity row and no mobile number", () => {
    const html = renderToStaticMarkup(ContactPage());

    expect(html).not.toContain("<dt>Nama badan usaha</dt>");
    expect(html).not.toContain("<dt>Alamat terdaftar</dt>");
    expect(html).not.toContain("<dt>Telepon</dt>");
    expect(html).not.toContain("<dt>NIB</dt>");
    expect(html).not.toContain("tel:");
    expect(html).not.toMatch(/(?:\+62|\b0)8\d{1,2}[\s-]?\d{3,4}[\s-]?\d{3,4}/);
    expect(html).not.toMatch(/\b\d{13}\b/);
  });

  // The page shows an email row only, so the description search engines display names the email
  // and no telephone. The Open Graph description is the same string, not a second copy to drift.
  it("describes the email the page shows and no telephone", () => {
    expect(metadata.description).toBe(
      "Cara menghubungi tim Lombakita melalui email dukungan untuk pertanyaan, keluhan, atau sengketa terkait layanan.",
    );
    expect(metadata.description).not.toMatch(/telepon/i);
    expect(metadata.openGraph?.description).toBe(metadata.description);
  });

  it("names no PT prefix or Perseroan/Perorangan suffix on the entity name", () => {
    const html = renderToStaticMarkup(ContactPage());

    expect(html).not.toMatch(/\bPT\s+KARYA/i);
    expect(html).not.toMatch(/Perseroan|Perorangan/i);
  });

  // NPWP is deliberately omitted from COMPANY and must never surface here, by literal or by
  // shape: the legacy 15-digit format is written NN.NNN.NNN.N-NNN.NNN wherever a company's NPWP
  // is quoted, so a check on the word alone would miss a value pasted in without its label.
  it("never renders an NPWP, by name or by shape", () => {
    const html = renderToStaticMarkup(ContactPage());

    expect(html).not.toMatch(/npwp/i);
    expect(html).not.toMatch(/\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/);
  });
});
