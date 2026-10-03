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

// The footer is on every page, so it is the one place the operator's identity is always visible.
// This pins the RENDERED footer against COMPANY: a rewrite that stops reading the module fails
// here even if the module itself stays correct.
describe("SiteFooter", () => {
  it("renders the legal name and the registered address", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.address);
  });

  it("renders the telephone number as a dial link", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toContain(`<a href="${COMPANY.phone.href}">${COMPANY.phone.display}</a>`);
  });

  it("renders the support email as a mailto link", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toContain(`href="mailto:${COMPANY.supportEmail}"`);
    expect(html).toContain(`>${COMPANY.supportEmail}</a>`);
  });

  it("renders the Tentang link first in a navigation labelled Informasi", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toContain('aria-label="Informasi"');
    expect(html).not.toContain('aria-label="Informasi legal"');
    expect(html).toMatch(/<a href="\/tentang">Tentang/);
    expect(html.indexOf('href="/tentang"')).toBeLessThan(html.indexOf('href="/syarat-ketentuan"'));
  });
});
