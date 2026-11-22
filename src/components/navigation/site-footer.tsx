import Link from "next/link";
import { LinkPendingSlot } from "@/components/ui";
import { COMPANY } from "@/config/company";

/**
 * Browser versions the interface is built and verified against.
 *
 * Derived from the modern CSS this app ships UNGATED — not from a support policy, because the repo
 * has no browserslist config to read one from. Re-derive rather than guess if the stylesheet gains
 * a newer feature:
 *
 *   text-wrap: pretty   Chrome/Edge 117 · Safari 17.5 (balance) · Firefox 121 (balance)
 *   :has()              Firefox 121 is the late one; Chrome 105, Safari 15.4
 *   color-mix(in srgb)  Chrome/Edge 111 · Firefox 113 · Safari 16.2
 *
 * The numbers below are the LATEST of those per engine. The genuine floor is lower — only
 * `color-mix()` breaks anything if unsupported, since an invalid value drops the whole background
 * declaration; `:has()` and `text-wrap` degrade to plain wrapping and an unstyled featured card,
 * which is why the note tells older browsers they still work. `backdrop-filter` is deliberately
 * absent: it is @supports-guarded with an opaque fallback, so it constrains nothing.
 */
const VERIFIED_BROWSERS = [
  { name: "Chrome", minimumVersion: "117" },
  { name: "Edge", minimumVersion: "117" },
  { name: "Firefox", minimumVersion: "121" },
  { name: "Safari", minimumVersion: "17.5" },
] as const;

/**
 * The legal and identity routes every page has to reach, in the order the two-column grid reads:
 * down the first column, then down the second.
 *
 * Kept beside the footer that renders them because this is the only navigation to them in the
 * app: a reader looking for the terms they agreed to, or for how to reach support, looks at the
 * bottom of whatever page they are on.
 */
const LEGAL_LINKS = [
  { href: "/tentang", label: "Tentang" },
  { href: "/kontak", label: "Kontak" },
  { href: "/syarat-ketentuan", label: "Syarat & Ketentuan" },
  { href: "/kebijakan-privasi", label: "Kebijakan Privasi" },
] as const;

const FOOTER_INFO_HEADING_ID = "footer-info-heading";

function describeBrowserSupport() {
  const versionedNames = VERIFIED_BROWSERS.map(
    (browser) => `${browser.name} ${browser.minimumVersion}+`,
  );
  const lastName = versionedNames[versionedNames.length - 1];
  const leadingNames = versionedNames.slice(0, -1);
  const browserList = `${leadingNames.join(", ")}, dan ${lastName}`;
  return `Tampilan terbaik di ${browserList}. Versi yang lebih lama tetap bisa dipakai, hanya sebagian detail tampilan yang berbeda.`;
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="stack-sm">
          <span className="footer-wordmark" aria-hidden="true" />
          <p className="footer-copy">
            Temukan kompetisi yang tepat, pahami persyaratannya, lalu melangkah dengan yakin.
          </p>
        </div>
        <div className="footer-info">
          <h2 id={FOOTER_INFO_HEADING_ID}>Informasi</h2>
          <nav aria-labelledby={FOOTER_INFO_HEADING_ID}>
            <ul className="footer-link-grid">
              {/* Every route here is indexable and so has no `loading.tsx` — the Suspense
                  boundary one creates strands their content outside the initial shell, which is
                  the defect that removed them. Their navigation is acknowledged at the link
                  instead. */}
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="footer-link">
                    {link.label}
                    <LinkPendingSlot />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>

      <div className="footer-legal">
        <div className="footer-legal-row">
          <a className="footer-link" href={`mailto:${COMPANY.supportEmail}`}>
            {COMPANY.supportEmail}
          </a>
        </div>
        <p className="footer-fine-print">{describeBrowserSupport()}</p>
      </div>
    </footer>
  );
}
