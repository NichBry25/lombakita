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

import TermsPage from "@/app/syarat-ketentuan/page";
import { COMPANY, LEGAL_DOCUMENT } from "@/config/company";

describe("TermsPage", () => {
  it("renders the company facts and document version this page reads", () => {
    const html = renderToStaticMarkup(TermsPage());

    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.supportEmail);
    expect(html).toContain(`mailto:${COMPANY.supportEmail}`);
    expect(html).toContain(LEGAL_DOCUMENT.version);
    expect(html).toContain(LEGAL_DOCUMENT.effectiveDateLabel);
  });

  it("never renders an NPWP, by name or by shape", () => {
    const html = renderToStaticMarkup(TermsPage());

    expect(html).not.toMatch(/npwp/i);
    expect(html).not.toMatch(/\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/);
  });

  // THE REFUND-BOUNDS PIN. This exact defect shipped once inside this step: clause 6's heading
  // read "Pembayaran tidak dapat ditarik kembali" with no qualifier, and clause 7 said nothing
  // about the candidate's money when an organizer pulls a competition. Read top to bottom that
  // composed into "no refund either way" — the extension DEC-0132 explicitly rejects, and in
  // Indonesia UU No. 8/1999 Pasal 18(1)(c) voids a clause stating a business may refuse to return
  // money paid. The heading now carries its own bound and clause 7 carries the carve-out sentence;
  // both are pinned here so neither can be silently reverted.
  describe("refund bounds (DEC-0131 vs DEC-0132)", () => {
    it("bounds clause 6's heading to the candidate's own initiative", () => {
      const html = renderToStaticMarkup(TermsPage());

      expect(html).toContain("Pembayaran tidak dapat ditarik kembali atas permintaan Anda");
      // The unqualified form is the defect. It must not appear as a heading anywhere on the page —
      // matched against a following "<", which is how a <h2> in this markup always ends.
      expect(html).not.toMatch(/Pembayaran tidak dapat ditarik kembali</);
    });

    it("carries clause 7's carve-out: clause 6 does not govern an organizer pulling the competition", () => {
      const html = renderToStaticMarkup(TermsPage());

      expect(html).toContain(
        "Keadaan ini berbeda dari bagian 6 dan tidak diatur olehnya",
      );
      expect(html).toContain(
        "bagian 6 tidak dapat dipakai untuk",
      );
    });
  });
});
