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
        <div className="footer-support">
          <h3>Tampilan terbaik di</h3>
          <ul className="footer-support-list">
            {VERIFIED_BROWSERS.map((browser) => (
              <li key={browser.name}>
                <span>{browser.name}</span>{" "}
                <span className="footer-support-version">{browser.minimumVersion}+</span>
              </li>
            ))}
          </ul>
          <p className="footer-support-note">
            Versi yang lebih lama tetap bisa dipakai — sebagian detail tampilan saja yang berbeda.
          </p>
        </div>
      </div>
    </footer>
  );
}
