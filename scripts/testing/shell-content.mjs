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
 * AND THE FOURTH, because the third asserted a FIXTURE where the sitemap enumerates ROWS. The
 * static set is five fixed paths and is covered exactly; the two dynamic families are 27
 * competitions and 14 organizers, and the check measured one of each. Proven insufficient: a
 * per-row branch in the competition detail's `generateMetadata` made every competition except the
 * fixture serve `noindex, nofollow` while the sitemap advertised all 27, and the check stayed
 * green. The sampling pass below reads the sitemap the app actually publishes and asserts the
 * directive on a spread of rows from each family.
 *
 * Usage: node scripts/testing/shell-content.mjs
 * Needs the app served at BASE_URL (default http://localhost:3000) and the seeded test matrix.
 */
import { BASE } from "./seeds.mjs";
import { measureShell } from "./lib-shell.mjs";
import { INDEXABLE_SHELL_ROUTES, SITEMAP_URL_FAMILIES } from "./indexable-shell-routes.mjs";

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

/**
 * The failure text for a page whose robots directive does not invite indexing, or null when it
 * does. Shared by the fixture pass and the sitemap sampling pass so the two cannot drift into
 * disagreeing about what an acceptable directive is.
 */
const robotsProblemFor = (path, directive) => {
  if (directive === null) {
    return (
      `${path} is in the sitemap but serves no robots meta tag at all. The root layout withholds ` +
      `indexing by default and every indexable page opts back in, so a page with no directive ` +
      `means the layout default stopped applying — which withholds far more than this page.`
    );
  }

  if (!/\bindex\b/.test(directive) || /\bnoindex\b/.test(directive)) {
    return (
      `${path} is advertised in the sitemap while serving ` +
      `<meta name="robots" content="${directive}">. The sitemap invites a crawler to a page that ` +
      `then tells it not to index. The usual cause is a page whose own metadata never declared ` +
      `INDEXABLE_ROBOTS, or a per-row branch that withholds it.`
    );
  }

  return null;
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
  const robotsProblem = robotsProblemFor(path, robotsDirective);
  if (robotsProblem) failures.push(robotsProblem);

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

/*
 * THE SAMPLING PASS: the rows the sitemap actually advertises, not a fixture standing in for them.
 *
 * THE RULE, stated so a failure is reproducible: take the family's URLs from the published
 * sitemap, sort them lexicographically, and pick SAMPLES_PER_FAMILY evenly spaced indices
 * INCLUDING the first and the last. Same sitemap in, same URLs sampled — a red run names a URL
 * anyone can re-fetch. Deliberately not random and not "the first N": random is unreproducible,
 * and a prefix samples whichever organizer sorts earliest every single time.
 *
 * IT REWRITES THE ORIGIN. The sitemap emits absolute URLs built from APP_BASE_URL, which is NOT
 * necessarily the host this check was pointed at — and a probe of this very check fetched the
 * unmutated server on port 3000 that way, reported the guard sound, and measured nothing. Rewriting
 * here means no caller can repeat that.
 */
const SAMPLES_PER_FAMILY = 5;

/** Evenly spaced indices across `length`, first and last included. */
const spreadIndices = (length, count) => {
  if (length <= count) return [...Array(length).keys()];
  if (count === 1) return [0];
  const step = (length - 1) / (count - 1);
  return [...new Set([...Array(count).keys()].map((i) => Math.round(i * step)))];
};

const sitemapResponse = await fetch(`${BASE}/sitemap.xml`);
const sitemapXml = await sitemapResponse.text();
const sitemapPaths = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
  try {
    return new URL(match[1]).pathname;
  } catch {
    return match[1];
  }
});

if (sitemapPaths.length === 0) {
  failures.push(
    `the sitemap at ${BASE}/sitemap.xml carried no <loc> entries (HTTP ${sitemapResponse.status}). ` +
      `A sampling pass over an empty list asserts nothing while reporting success, so this is a ` +
      `refusal rather than a pass.`,
  );
}

for (const family of SITEMAP_URL_FAMILIES) {
  const paths = sitemapPaths.filter(family.matches).sort();

  // Rule 38: an instrument declares its subject and refuses what it cannot classify. A family that
  // matched nothing means the sitemap changed shape, and sampling zero rows would report green.
  if (paths.length === 0) {
    failures.push(
      `the sitemap advertises no ${family.name} URLs at all, so this family was sampled zero ` +
        `times. Either the sitemap stopped emitting them or this check's family pattern is stale; ` +
        `both leave the family unmeasured.`,
    );
    // Printed before continuing, so this family still reports one line like every other. Silence
    // here would make the check emit fewer lines exactly when it is most broken, and the Rule 36
    // probe counts those lines to tell "the mutation failed" from "everything failed".
    console.log(`  FAIL ${family.name} — 0 advertised URLs, so nothing was sampled`);
    continue;
  }

  const sampled = spreadIndices(paths.length, SAMPLES_PER_FAMILY).map((index) => paths[index]);
  const problems = [];

  for (const path of sampled) {
    const html = await (await fetch(`${BASE}${path}`)).text();
    const problem = robotsProblemFor(path, robotsDirectiveOf(html));
    if (problem) {
      problems.push(problem);
      failures.push(problem);
    }
  }

  console.log(
    `  ${problems.length === 0 ? "ok  " : "FAIL"} ${family.name} — ${sampled.length} of ` +
      `${paths.length} advertised URLs sampled, ${problems.length} refusing indexing`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`\nFAIL ${failure}`);
  console.error(`\n${failures.length} shell-content check(s) failed.`);
  process.exit(1);
}

console.log(
  `\n${INDEXABLE_SHELL_ROUTES.length}/${INDEXABLE_SHELL_ROUTES.length} indexable routes serve their content in the initial shell, and every sampled sitemap URL declares itself indexable.`,
);
