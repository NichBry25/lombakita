/*
 * Is every indexable page's content in the initial shell, or only promised to a client that runs?
 *
 * server-render.mjs asks this of `/competitions` alone. It was the page whose defect prompted the
 * check, and the check stayed the shape of that one page — so the two detail routes shipped the
 * same defect, unnoticed, for as long as they existed: a competition page and an organizer page
 * served header and footer chrome and nothing else to anyone who does not run JavaScript. Both are
 * pages the launch exists to make discoverable.
 *
 * WHAT CAUSES IT, stated because the fix is not obvious from the symptom. A route segment with a
 * `loading.tsx` gets a Suspense boundary. Next flushes the shell — skeleton included — as soon as
 * it has one, and streams the resolved page into `<div hidden>` for an inline script to swap in.
 * With scripting off the swap never happens. Nothing about the page's own code looks wrong; the
 * boundary is the whole cause, and it is a file in a neighbouring directory.
 *
 * WHY IT CANNOT BE CAUGHT BY READING. The boundary only strands content when the page's render
 * actually lands after the flush, which depends on how much there is to render. `/kontak` and
 * `/syarat-ketentuan` had identical `loading.tsx` files and identical page structure; the short
 * one kept its content in the shell and the long one did not. The legal pages crossed that
 * threshold by growing, with no edit to any of the machinery — which is the case this check exists
 * for, and the reason it measures rather than inspects.
 *
 * TWO SIGNALS, and both must hold. The ratio catches content leaving the shell wholesale; the
 * needle catches the case where a page keeps its frame and loses its body. Neither alone is
 * enough: a page can stream 60% of itself and still carry its heading, and a page can score a high
 * ratio while the part a reader came for is the part that streamed.
 *
 * AND THE THIRD SIGNAL, which is about a different failure: a page that serves its content
 * perfectly and then tells the crawler not to index it. Indexing is opt-in — the root layout
 * withholds by default and a page opts in by declaring `INDEXABLE_ROBOTS` — so a page can be added
 * to `STATIC_INDEXABLE_PATHS`, appear in the sitemap, and still serve `noindex, nofollow` because
 * nobody declared it. The sitemap then advertises a page that refuses. Reproduced: a route added to
 * the indexable set and left undeclared was advertised in the sitemap while serving
 * `<meta name="robots" content="noindex, nofollow">`. Four tests fired on that edit and all four
 * were counts, which go green when someone updates the number. This asserts the property instead,
 * against the page as served — the only place the composition of layout default, page declaration
 * and sitemap entry is actually observable.
 *
 * Usage: node scripts/testing/shell-content.mjs
 * Needs the app served at BASE_URL (default http://localhost:3000) and the seeded test matrix.
 */
import { BASE } from "./seeds.mjs";
import { measureShell } from "./lib-shell.mjs";
import { INDEXABLE_SHELL_ROUTES } from "./indexable-shell-routes.mjs";

/*
 * A page in the shell scores ~0.997 and a streaming one ~0.13 to ~0.42, measured across all seven
 * routes below. There is no observed value between 0.42 and 0.99, so the threshold sits in open
 * space rather than being tuned against a page that nearly failed. It is deliberately not 1.0:
 * Next emits one empty `<div hidden>` per document as a stream target even when nothing streams
 * into it, and a decorative subtree that legitimately carries `hidden` would count against a page
 * that is entirely correct.
 */
const MINIMUM_SHELL_RATIO = 0.9;

/**
 * The `content` of the page's own robots meta tag, or null when it emits none.
 *
 * Matched loosely on attribute order and quoting because this is Next's output, not ours: the
 * assertion is about what the directive SAYS, and a check that only recognised one attribute
 * ordering would report "no robots meta" for a page that has one.
 */
const robotsDirectiveOf = (html) => {
  const tag = html.match(/<meta[^>]*\bname=["']robots["'][^>]*>/i)?.[0];
  if (!tag) return null;
  return tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? null;
};

const failures = [];

for (const { path, needle, label } of INDEXABLE_SHELL_ROUTES) {
  const { html, markup, paintedBytes, readableBytes, shellRatio } = await measureShell(BASE, path);
  const ratio = shellRatio.toFixed(3);
  // Read before this route's checks run, so the per-route line below reports whether THIS route
  // passed rather than only whether its ratio cleared the threshold. A line reading `ok` above a
  // route that failed a different signal is an instrument reporting a result it did not measure.
  const failuresBefore = failures.length;

  if (shellRatio < MINIMUM_SHELL_RATIO) {
    failures.push(
      `${path} keeps only ${ratio} of its readable bytes in the initial shell ` +
        `(${paintedBytes} of ${readableBytes}). The rest is inside a hidden streaming container ` +
        `that needs JavaScript to appear, so a crawler and a reader without scripting get a ` +
        `fraction of this page. The usual cause is a \`loading.tsx\` in this route's segment or ` +
        `an ancestor of it.`,
    );
  }

  if (!markup.includes(needle)) {
    // Naming which of the two shapes this is, rather than leaving the next reader to work it out:
    // content that is in the bytes but not in the painted markup is the streaming defect, and
    // content that is in neither is a page that changed or a stale needle.
    const inBytes = html.includes(needle);

    failures.push(
      inBytes
        ? `${path} carries ${label} ("${needle}") ONLY inside a <script> payload or a hidden ` +
            `streaming container. Both need JavaScript to become visible, so this page is ` +
            `client-rendered in the shape a crawler cannot read.`
        : `${path} does not carry ${label} ("${needle}") anywhere in its response. Either the ` +
            `page no longer renders it — in which case this needle needs updating — or the page ` +
            `is broken.`,
    );
  }

  const robotsDirective = robotsDirectiveOf(html);

  if (robotsDirective === null) {
    failures.push(
      `${path} is in the sitemap but serves no robots meta tag at all. The root layout withholds ` +
        `indexing by default and every indexable page opts back in, so a page with no directive ` +
        `means the layout default stopped applying — which withholds far more than this page.`,
    );
  } else if (!/\bindex\b/.test(robotsDirective) || /\bnoindex\b/.test(robotsDirective)) {
    failures.push(
      `${path} is advertised in the sitemap while serving ` +
        `<meta name="robots" content="${robotsDirective}">. The sitemap invites a crawler to a ` +
        `page that then tells it not to index. The usual cause is a page added to ` +
        `STATIC_INDEXABLE_PATHS whose own metadata never declared INDEXABLE_ROBOTS.`,
    );
  }

  if (markup.includes("skeleton")) {
    failures.push(
      `${path} paints a skeleton placeholder with scripting disabled. A placeholder that no ` +
        `script will ever replace is what a reader is left with when the real content never ` +
        `arrives.`,
    );
  }

  const passed = failures.length === failuresBefore;
  console.log(
    `  ${passed ? "ok  " : "FAIL"} ${path} — shell ${ratio}, robots ${robotsDirective ?? "(none)"}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`\nFAIL ${failure}`);
  console.error(`\n${failures.length} shell-content check(s) failed.`);
  process.exit(1);
}

console.log(
  `\n${INDEXABLE_SHELL_ROUTES.length}/${INDEXABLE_SHELL_ROUTES.length} indexable routes serve their content in the initial shell and declare themselves indexable.`,
);
