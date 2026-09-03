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

describe("PrivacyPage", () => {
  it("renders the company facts and document version this page reads", () => {
    const html = renderToStaticMarkup(PrivacyPage());

    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.address);
    expect(html).toContain(COMPANY.supportEmail);
    expect(html).toContain(`mailto:${COMPANY.supportEmail}`);
    expect(html).toContain(LEGAL_DOCUMENT.version);
    expect(html).toContain(LEGAL_DOCUMENT.effectiveDateLabel);
  });

  it("never renders an NPWP, by name or by shape", () => {
    const html = renderToStaticMarkup(PrivacyPage());

    expect(html).not.toMatch(/npwp/i);
    expect(html).not.toMatch(/\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/);
  });
});
