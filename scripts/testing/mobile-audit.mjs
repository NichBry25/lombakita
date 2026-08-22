/*
 * Mobile layout audit. Walks the page inventory at phone width and reports the three faults that
 * are measurable rather than a matter of taste:
 *
 *   overflow  — the document scrolls horizontally, which nothing on a phone should do
 *   wide      — an element extends past the viewport edge (the "too close to the border" report)
 *   target    — an interactive control smaller than the 44x44px minimum (ui-preferences §11)
 *
 * Taste still needs eyes; this finds the things eyes miss and proves the fixes landed.
 *
 * Three things it does before it will report anything, each of which it used to skip:
 *   - refuses outright unless the browser is loading the stylesheet on disk (lib-css-fingerprint)
 *   - opens collapsed sections, whose contents are ABSENT from the DOM rather than hidden
 *   - fails the run on a page it could not measure, instead of counting it toward the total
 */
import { launch, contextFor, MOBILE, settle, expandCollapsibles } from "./lib-browser.mjs";
import { preflightOrRefuse } from "./lib-css-fingerprint.mjs";
import { finishAudit } from "./lib-audit-baseline.mjs";
import { PAGES } from "./pages.mjs";
import { BASE, USERS } from "./seeds.mjs";

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const targets = PAGES.filter((p) => !filter || filter.test(p.id));

const audit = async (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    // An element wider than the screen is only a fault if it actually paints past the edge. A
    // marquee track is deliberately thousands of pixels wide inside a clipping parent, and that is
    // correct — so walk up and skip anything already clipped by an ancestor.
    const isClipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflowX === "hidden" || o.overflowX === "auto" || o.overflowX === "scroll") {
          return true;
        }
      }
      return false;
    };

    const wide = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.position === "fixed") continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (isClipped(el)) continue;
      // Only report the outermost offender; a wide parent makes every child look wide too.
      if (!wide.some((w) => w.el.contains(el))) wide.push({ el, r });
    }

    const small = [];
    // §11's 44x44 minimum governs CONTROLS, not inline text links — a card title or a link inside a
    // sentence is prose, and padding it to 44px would wreck the typography it lives in. Buttons,
    // icon buttons, and form controls are the set the rule is about.
    const controls =
      "button, [role=button], input:not([type=hidden]), select, textarea, .ui-button, .ui-icon-button, a[class*='button']";
    for (const el of document.querySelectorAll(controls)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      // A visually-hidden file input is driven by a visible label or button; that control is the
      // real target and gets measured on its own.
      if (
        el.matches(".sr-only, .pf-visually-hidden") ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        continue;
      }
      // A checkbox or radio inside a label is tapped through the whole label, so the label is the
      // real target. Measure that instead of the 16px box the browser draws.
      const label = el.closest("label");
      const box = label && label.contains(el) ? label.getBoundingClientRect() : r;
      if (box.width < 44 || box.height < 44) {
        small.push(`${describe(el)} ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }

    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: vw,
      wide: wide.map(({ el, r }) => `${describe(el)} right=${Math.round(r.right)}`),
      small: [...new Set(small)],
      smallTotal: small.length,
    };
  });

const browser = await launch();
const contexts = new Map();
const measured = [];
const unmeasurable = [];
let preflightDone = false;

for (const spec of targets) {
  const key = spec.as ?? "anon";
  if (!contexts.has(key)) {
    contexts.set(key, await contextFor(browser, spec.as ? USERS[spec.as].email : null));
  }
  const page = await contexts.get(key).newPage();
  await page.setViewportSize(MOBILE);
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Heavy forms measure mid-layout at shorter waits and report phantom 25px-tall inputs.
    await settle(page);
    // Once, on the first page that loads: everything after this depends on the browser seeing the
    // stylesheet the working tree holds, and there is no point measuring 104 more pages against a
    // stylesheet that is not the one under test.
    if (!preflightDone) {
      await preflightOrRefuse(page, "mobile-audit");
      preflightDone = true;
    }
    await expandCollapsibles(page);
    measured.push({ id: spec.id, path: spec.path, ...(await audit(page)) });
  } catch (error) {
    unmeasurable.push({ id: spec.id, reason: String(error).slice(0, 160) });
  }
  await page.close();
}

await browser.close();

/**
 * Prints the report and returns its findings. Called by `finishAudit` only once the run has been
 * established as one that measured everything it claims to describe.
 */
const measure = () => {
  // Keyed findings, collapsed. Three sibling `section.content-section` elements past the edge
  // produce the same descriptor, and three entries under one key would make the baseline unable to
  // tell them apart — a "healed" report would fire on the wrong one. One key, with how many
  // elements matched it.
  const byKey = new Map();
  const add = (key, detail) => {
    const existing = byKey.get(key);
    if (existing) existing.occurrences += 1;
    else byKey.set(key, { key, occurrences: 1, ...detail });
  };
  for (const page of measured) {
    const overflow = page.scrollWidth > page.viewport + 1;
    if (!overflow && page.wide.length === 0 && page.small.length === 0) continue;

    console.log(`\n${page.id}  (${page.path})`);
    if (overflow) {
      console.log(`  OVERFLOW  scrollWidth ${page.scrollWidth} > viewport ${page.viewport}`);
      add(`${page.id}|overflow`, { scrollWidth: page.scrollWidth });
    }

    // THE COUNT IS THE FINDING; the listing is a convenience. Printing six of eighteen and no total
    // let a reader fix six things and believe they were done — measured at 18 undersized controls on
    // the competition editor, 16 unique, six printed, no number anywhere saying so.
    console.log(
      `  ${page.wide.length} element(s) past the viewport edge, ${page.small.length} ` +
        `undersized control(s) (${page.smallTotal} including repeats)`,
    );
    for (const w of page.wide.slice(0, 6)) console.log(`  WIDE      ${w}`);
    if (page.wide.length > 6) console.log(`  WIDE      …and ${page.wide.length - 6} more`);
    for (const s of page.small.slice(0, 6)) console.log(`  TARGET    ${s}`);
    if (page.small.length > 6) console.log(`  TARGET    …and ${page.small.length - 6} more`);

    for (const w of page.wide) {
      add(`${page.id}|wide|${w.split(" right=")[0]}`, { detail: w });
    }
    for (const s of page.small) {
      // Keyed on the control, not on its measured size: a 40x40 that becomes 40x43 is the same
      // known finding, and a baseline that churns on a pixel is a baseline nobody re-takes.
      add(`${page.id}|target|${s.replace(/ \d+x\d+$/, "")}`, { detail: s });
    }
  }

  const findings = [...byKey.values()];
  const cleanPages = measured.length - new Set(findings.map((f) => f.key.split("|")[0])).size;
  console.log(`\n${cleanPages}/${measured.length} pages clean at ${MOBILE.width}px.`);
  return findings;
};

finishAudit({
  name: "mobile-audit",
  measure,
  unmeasurable,
  note: `${MOBILE.width}px viewport, ${measured.length} pages`,
});
