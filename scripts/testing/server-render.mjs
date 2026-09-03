/*
 * Does the public listing arrive as HTML, or only as a promise to fetch one?
 *
 * `/competitions` used to be a client component that fetched its rows from `/api/v1/competitions`
 * inside an effect. `isLoading` started true and nothing outside the browser flipped it, so a
 * reader with JavaScript off, a text browser, and every crawler that does not execute scripts got
 * six skeleton cards and nothing else, permanently. The page also built as Static, which meant the
 * skeleton was what got prerendered and cached.
 *
 * This check never runs JavaScript at all. It asks the server for the page the way a crawler does,
 * with `fetch`, and looks at the bytes that come back.
 *
 * TWO THINGS ARE STRIPPED BEFORE ANYTHING IS MATCHED, and both are load-bearing. Each one is a way
 * the response can carry the listing while a scripting-disabled reader still sees none of it.
 *
 *   <script> blocks. The React server-component payload is embedded in the document inside them,
 *   so a competition title appears in the bytes of a page that renders nothing at all.
 *
 *   <div hidden> containers. When a route segment has a `loading.tsx`, Next flushes the skeleton
 *   into the shell and streams the real listing into `<div hidden id="S:0">`, which an inline
 *   script swaps into place. With scripting off the swap never happens: the skeleton is what stays
 *   on screen and the listing stays hidden. This was measured on this very page, and it is why the
 *   segment has no `loading.tsx`.
 *
 * What survives both strips is the markup a browser paints with scripting disabled, which is the
 * only thing this check will accept as evidence.
 *
 * Usage: node scripts/testing/server-render.mjs
 * Needs the app served at BASE_URL (default http://localhost:3000) and the seeded test matrix.
 */
import { BASE } from "./seeds.mjs";

// A published, registration-open competition in the seeded matrix. It carries a category and a
// searchable title, so one fixture serves the plain, filtered and searched cases.
const SEEDED = {
  title: "Seed Hackathon Nusantara",
  href: "/competitions/seed-academy/seed-open",
  category: "hackathon",
  searchTerm: "hackathon",
};

// A different competition_category enum member, used to prove the filter excludes as well as it
// includes. Must stay a real category — see check 4.
const EXCLUDING_CATEGORY = "business";

/**
 * Removes each `<div hidden ...>` and everything up to its matching close tag.
 *
 * Depth-counted rather than matched with a regex, because these containers hold whole page
 * subtrees full of nested divs and a non-greedy match would stop at the first `</div>` inside
 * them, leaving most of the streamed content in place and defeating the strip.
 */
const stripHiddenContainers = (html) => {
  const opener = /<div\b[^>]*\bhidden\b[^>]*>/i;
  let out = html;

  for (;;) {
    const start = out.search(opener);
    if (start === -1) return out;

    const openTag = out.slice(start).match(opener)[0];
    let cursor = start + openTag.length;
    let depth = 1;

    while (depth > 0) {
      const nextOpen = out.indexOf("<div", cursor);
      const nextClose = out.indexOf("</div>", cursor);

      // An unbalanced document would otherwise spin here. Dropping the remainder is the
      // conservative move: it can only remove evidence, never invent it.
      if (nextClose === -1) return out.slice(0, start);

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + 4;
      } else {
        depth -= 1;
        cursor = nextClose + 6;
      }
    }

    out = out.slice(0, start) + out.slice(cursor);
  }
};

/** What a scripting-disabled client actually paints: no script payloads, no hidden stream targets. */
const renderedMarkupOf = (html) =>
  stripHiddenContainers(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));

const fetchRendered = async (path) => {
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: "text/html" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}, so nothing could be measured`);
  }

  const html = await response.text();
  return { html, markup: renderedMarkupOf(html) };
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// 1. The plain listing carries competitions in its markup.
{
  const { html, markup } = await fetchRendered("/competitions");

  const carriesCard = markup.includes(SEEDED.href);
  const carriesTitle = markup.includes(SEEDED.title);

  check(
    carriesCard,
    `/competitions does not carry "${SEEDED.href}" in its rendered markup. The listing is not ` +
      `server-rendered: a client with scripting disabled sees no competitions on this page.`,
  );
  check(
    carriesTitle,
    `/competitions does not carry the title "${SEEDED.title}" in its rendered markup.`,
  );

  // Names the trap rather than leaving the next reader to rediscover it: if the title is in the
  // document but not in the painted markup, the page is shipping data to a client that must run to
  // reveal it, which is the defect wearing the appearance of a fix.
  if (!carriesTitle && html.includes(SEEDED.title)) {
    failures.push(
      `"${SEEDED.title}" appears in /competitions ONLY inside a <script> payload or a hidden ` +
        `streaming container. Both need JavaScript to become visible, so this is the ` +
        `client-rendered shape rather than server rendering.`,
    );
  }

  // A placeholder is what the reader is left with when the real thing never arrives, so its
  // presence in painted markup is a failure even when the listing is also somewhere in the bytes.
  check(
    !markup.includes("skeleton-card"),
    `/competitions paints a skeleton card with scripting disabled. A placeholder that no script ` +
      `will ever replace is the defect this page was rewritten to remove.`,
  );
}

// 2. A filter applied straight from the address bar is answered by the server.
{
  const { markup } = await fetchRendered(`/competitions?category=${SEEDED.category}`);

  check(
    markup.includes(SEEDED.href),
    `/competitions?category=${SEEDED.category} does not carry "${SEEDED.href}". A filtered URL ` +
      `must be answered by the server, so it can be shared, reloaded and crawled.`,
  );
}

// 3. So is a search term.
{
  const { markup } = await fetchRendered(`/competitions?q=${SEEDED.searchTerm}`);

  check(
    markup.includes(SEEDED.href),
    `/competitions?q=${SEEDED.searchTerm} does not carry "${SEEDED.href}". Search must resolve ` +
      `on the server for a searched URL to be reloadable.`,
  );
}

// 4. A filter that excludes the fixture must actually exclude it. Without this the three checks
//    above would pass against a page that ignores its query string and always renders everything.
//
//    The excluding value has to be a real member of the competition_category enum. The listing
//    service applies a category filter only when the token is a recognised category and ignores
//    anything else, so an invented token would return the full listing and fail this check while
//    the filtering it is supposed to measure works perfectly.
{
  const { markup } = await fetchRendered(`/competitions?category=${EXCLUDING_CATEGORY}`);

  check(
    !markup.includes(SEEDED.href),
    `/competitions?category=${EXCLUDING_CATEGORY} still carries "${SEEDED.href}", which is a ` +
      `${SEEDED.category}. The page is rendering on the server but ignoring its filters.`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} server-rendering check(s) failed.`);
  process.exit(1);
}

console.log("4/4 server-rendering checks passed: /competitions is readable without JavaScript.");
