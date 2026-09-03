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

import ContactPage from "@/app/kontak/page";
import { COMPANY } from "@/config/company";

// These strings are owner-ruled and byte-exact, and nothing downstream verifies them: a typo in
// src/config/company.ts would otherwise ship silently to the one page whose whole purpose is
// stating them correctly. This pins the RENDERED page, not the module — a future page rewrite
// that stops reading COMPANY would fail here even if the module itself stayed correct.
describe("ContactPage", () => {
  it("renders every company fact from the single source of truth", () => {
    const html = renderToStaticMarkup(ContactPage());

    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.address);
    expect(html).toContain(COMPANY.supportEmail);
    expect(html).toContain(`mailto:${COMPANY.supportEmail}`);
    expect(html).toContain(COMPANY.phoneDisplay);
    expect(html).toContain(`tel:${COMPANY.phoneDial}`);
    expect(html).toContain(COMPANY.nib);
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
