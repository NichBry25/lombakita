/**
 * The company behind Lombakita, stated once.
 *
 * Every surface that names the operator reads from here: the site footer, the contact page, the
 * terms and the privacy policy. A second literal copy of the address or the entity name is the
 * defect this module exists to prevent, because the copy that nobody remembers to update is the
 * one a reader eventually finds.
 *
 * There is deliberately no telephone field. `supportEmail` is the only contact channel the
 * platform publishes, so support arrives in writing on an address the company owns. A personal
 * mobile number is not a company channel: it reaches one individual, it cannot be handed over, and
 * it stays reachable long after that person stops answering for the company.
 */
export const COMPANY = {
  legalName: "KARYA TALENTA NUSANTARA",
  address:
    "Jl. Raya Satelit Utara KN-8, RT 088 / RW 03, Tanjungsari, Sukomanunggal, Kota Surabaya, Jawa Timur 60187",
  supportEmail: "dukungan@lombakita.com",
  nib: "2008260000397",
} as const;

/**
 * The one address this platform is published at.
 *
 * Stated here beside the other identity constants because it is the same kind of fact: something a
 * reader can check against the outside world, which must have exactly one source. It is the value
 * `APP_BASE_URL` is asserted to equal in production (`env-shape.ts`), and it exists because a shape
 * check cannot see a wrong value — `https://example.com` is a perfectly valid https origin, and it
 * would have produced a sitemap and a robots.txt pointing an entire launch at someone else's site.
 *
 * Not read at runtime. The application still resolves its origin from the environment, so a
 * preview deployment keeps describing itself; this is the constant the deploy gate compares
 * production against.
 */
export const CANONICAL_SITE_ORIGIN = "https://lombakita.com";

/**
 * Version and effective date shown on the terms and the privacy policy.
 *
 * One constant for both documents: they were written together against the same reading of the
 * product, so a reader who compares them should not find two different dates and have to guess
 * which one is current. Bump both together when either document changes substantively.
 */
export const LEGAL_DOCUMENT = {
  version: "1.0",
  // The date these documents became publicly readable. A live, operative document that claims a
  // future effective date misstates its own standing, so this never runs ahead of the deploy.
  effectiveDate: "2026-09-04",
  effectiveDateLabel: "4 September 2026",
} as const;
