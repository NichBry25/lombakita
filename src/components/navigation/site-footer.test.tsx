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

import { SiteFooter } from "@/components/navigation/site-footer";
import { COMPANY } from "@/config/company";

// The footer is on every page. This pins the RENDERED footer against COMPANY: a rewrite that stops
// reading the module fails here even if the module itself stays correct.
describe("SiteFooter", () => {
  it("renders the support email as a mailto link, once", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toContain(`href="mailto:${COMPANY.supportEmail}"`);
    expect(html).toContain(`>${COMPANY.supportEmail}</a>`);
    expect(html.split(COMPANY.supportEmail)).toHaveLength(3);
  });

  it("shows no company name, address, telephone number or registration number", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).not.toContain("tel:");
    expect(html).not.toMatch(/(?:\+62|\b0)8\d{1,2}[\s-]?\d{3,4}[\s-]?\d{3,4}/);
    expect(html).not.toMatch(/\b\d{13}\b/);
    expect(html).not.toMatch(/Jl\./);
    expect(html).not.toContain("footer-legal-entity");
  });

  it("names its links in a heading and reads the grid down the first column, then the second", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    const linkOrder = [
      'href="/tentang"',
      'href="/kontak"',
      'href="/syarat-ketentuan"',
      'href="/kebijakan-privasi"',
    ].map((marker) => html.indexOf(marker));

    expect(html).toContain('<h2 id="footer-info-heading">Informasi</h2>');
    expect(html).toContain('aria-labelledby="footer-info-heading"');
    expect(html).toMatch(/<a href="\/tentang"[^>]*>Tentang/);
    expect(linkOrder).toEqual([...linkOrder].sort((first, second) => first - second));
    expect(linkOrder.every((position) => position > -1)).toBe(true);
  });

  it("writes the browser note as one sentence without a dash", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    const finePrint = html.match(/<p class="footer-fine-print">(.*?)<\/p>/)?.[1];

    expect(finePrint).toBe(
      "Tampilan terbaik di Chrome 117+, Edge 117+, Firefox 121+, dan Safari 17.5+. Versi yang lebih lama tetap bisa dipakai, hanya sebagian detail tampilan yang berbeda.",
    );
    expect(finePrint).not.toContain("—");
  });
});
