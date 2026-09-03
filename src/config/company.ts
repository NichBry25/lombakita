/**
 * The company behind Lombakita, stated once.
 *
 * Every surface that names the operator reads from here: the site footer, the contact page, the
 * terms and the privacy policy. A second literal copy of the address or the entity name is the
 * defect this module exists to prevent, because the copy that nobody remembers to update is the
 * one a reader eventually finds.
 *
 * The phone number is kept as two fields on purpose. The dialable form carries no spaces or
 * dashes so `tel:` hands the dialer something it can use, and the printed form is grouped so a
 * person can read it back over a call.
 */
export const COMPANY = {
  legalName: "KARYA TALENTA NUSANTARA",
  address:
    "Jl. Raya Satelit Utara KN-8, RT 088 / RW 03, Tanjungsari, Sukomanunggal, Kota Surabaya, Jawa Timur 60187",
  supportEmail: "dukungan@lombakita.com",
  phoneDisplay: "+62 813-5773-4540",
  phoneDial: "+6281357734540",
  nib: "2008260000397",
} as const;

/**
 * Version and effective date shown on the terms and the privacy policy.
 *
 * One constant for both documents: they were written together against the same reading of the
 * product, so a reader who compares them should not find two different dates and have to guess
 * which one is current. Bump both together when either document changes substantively.
 */
export const LEGAL_DOCUMENT = {
  version: "1.0",
  // Set to the intended production deploy date, not the drafting date (2026-09-03): a document
  // that says it took effect before it was actually live to anyone would misstate its own history.
  effectiveDate: "2026-10-01",
  effectiveDateLabel: "1 Oktober 2026",
} as const;
