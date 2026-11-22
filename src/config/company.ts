/**
 * How a reader reaches Lombakita, stated once.
 *
 * Every surface that names the way to reach the team reads from here: the site footer, the contact
 * page, the about page, the terms and the privacy policy. A second literal copy of the support
 * email is the defect this module exists to prevent, because the copy that nobody remembers to
 * update is the one a reader eventually finds.
 */
export const COMPANY = {
  supportEmail: "dukungan@lombakita.com",
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
 * Version, effective date and last-updated date shown on the terms and the privacy policy.
 *
 * One constant for both documents: they were written together against the same reading of the
 * product, so a reader who compares them should not find two different dates and have to guess
 * which one is current. Bump the version when either document changes substantively, and move
 * `updatedDate` with it.
 */
export const LEGAL_DOCUMENT = {
  version: "1.2",
  // The date these documents became publicly readable. A live, operative document that claims a
  // future effective date misstates its own standing, so this never runs ahead of the deploy.
  effectiveDate: "2026-11-22",
  effectiveDateLabel: "22 November 2026",
  // When the text last changed, which is not the same event as taking effect: a correction to a
  // live document leaves `effectiveDate` where it was and moves this one.
  updatedDate: "2026-11-22",
  updatedDateLabel: "22 November 2026",
} as const;
