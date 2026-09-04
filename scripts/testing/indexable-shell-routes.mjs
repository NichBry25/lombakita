/*
 * The routes shell-content.mjs measures, and the body text it looks for on each.
 *
 * A separate module from the check itself so a test can import the table without running the
 * check — `shell-content.mjs` fetches pages at import time, so importing it to read a constant
 * would execute a whole measurement run. `indexable-routes.test.ts` asserts this table covers the
 * indexable set declared in `src/config/indexable-routes.ts`, which is what stops a page being
 * added to that set and silently skipping the check (Rule 38: an instrument declares its subject
 * as data and refuses what it cannot classify).
 *
 * THE NEEDLE DISCIPLINE, which is the part that is easy to get wrong twice.
 *
 *   Not chrome. The site header and footer are in the shell of even a fully streaming page — that
 *   is exactly what a broken page serves — so a needle taken from them passes on the pages this
 *   check exists to catch. `KARYA TALENTA NUSANTARA` is in the footer of all seven and would have
 *   been a natural, useless choice.
 *
 *   Not the `<title>`. It is in the head, so it is in the shell for the same reason. The
 *   competition detail needle WAS the competition's title, and it stayed green while that route
 *   served its entire body from a hidden container. The Rule 36 probe found it.
 *
 *   Contiguous in the markup. React separates an interpolated value from adjacent literal text
 *   with a `<!-- -->` marker, and the brand marker wraps a word of the landing hero in a `<span>`,
 *   so neither of those headings matches as a substring however correct the page is.
 */
export const INDEXABLE_SHELL_ROUTES = [
  {
    path: "/",
    // The hero LEAD rather than the heading: the `<h1>` wraps one word in a `<span>` for the brand
    // marker, so its text is not contiguous and no substring of it would match.
    needle: "Jelajahi kompetisi dari penyelenggara yang bisa kamu percaya.",
    label: "the landing page hero lead",
  },
  {
    path: "/competitions",
    needle: "Seed Hackathon Nusantara",
    label: "a seeded competition in the listing",
  },
  {
    path: "/competitions/seed-academy/seed-open",
    // NOT the competition's title — see the head note. A section heading is body and only body.
    needle: "Gambaran umum",
    label: "the competition's overview heading",
  },
  {
    path: "/institution/seed-academy",
    // Not "Profil <name>": that heading interpolates the organizer's name, so React splits it.
    needle: "Hubungi penyelenggara",
    label: "the organizer's contact heading",
  },
  {
    path: "/kontak",
    needle: "Identitas penyelenggara sistem",
    label: "the operator identity heading",
  },
  {
    path: "/syarat-ketentuan",
    needle: "1. Tentang layanan ini",
    label: "the terms' first clause",
  },
  {
    path: "/kebijakan-privasi",
    needle: "1. Siapa yang mengelola data Anda",
    label: "the privacy policy's first clause",
  },
];

/**
 * A representative URL for each indexable route family, in the shape the config declares.
 *
 * The two dynamic families are seeded fixtures rather than patterns, because the check has to
 * fetch a real page. This mapping is what lets the coverage test compare a table of concrete URLs
 * against a config that names families.
 */
export const DYNAMIC_FAMILY_FIXTURES = {
  "/competitions/[institutionSlug]/[slug]": "/competitions/seed-academy/seed-open",
  "/institution/[institutionSlug]": "/institution/seed-academy",
};
