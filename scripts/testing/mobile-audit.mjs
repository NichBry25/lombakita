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
 * It walks the inventory once per width in MOBILE_VIEWPORTS (lib-browser.mjs), because one width
 * is not mobile. See that declaration for what the single width was hiding.
 *
 * Three things it does before it will report anything, each of which it used to skip:
 *   - refuses outright unless the browser is loading the stylesheet on disk (lib-css-fingerprint)
 *   - opens collapsed sections, whose contents are ABSENT from the DOM rather than hidden
 *   - fails the run on a page it could not measure, instead of counting it toward the total
 */
import {
  launch,
  contextFor,
  MOBILE_VIEWPORTS,
  settle,
  expandCollapsibles,
} from "./lib-browser.mjs";
import { preflightOrRefuse } from "./lib-css-fingerprint.mjs";
import { finishAudit } from "./lib-audit-baseline.mjs";
import { finding } from "./finding-classes.mjs";
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
        small.push({
          descriptor: describe(el),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }

    const uniqueSmall = [];
    const seenSmall = new Set();
    for (const entry of small) {
      const identity = `${entry.descriptor} ${entry.width}x${entry.height}`;
      if (seenSmall.has(identity)) continue;
      seenSmall.add(identity);
      uniqueSmall.push(entry);
    }

    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: vw,
      // Both edges travel out of the browser, because the `wide` magnitude is the overshoot in
      // whichever direction it goes and only `left` can describe the one scrollWidth cannot see.
      wide: wide.map(({ el, r }) => ({
        descriptor: describe(el),
        right: Math.round(r.right),
        left: Math.round(r.left),
      })),
      small: uniqueSmall,
      smallTotal: small.length,
    };
  });

/**
 * Awaits `work`, and gives up on it after `budgetMs`.
 *
 * For teardown only, and it exists because teardown was observed never finishing. With every
 * navigation on a page failing, `page.close()` returned nothing at all: the run sat with its
 * browser open and produced no output for sixteen minutes, on roughly half the attempts, and a
 * measurement that never reports is the same failure as one that reports what it never measured.
 * Nothing past this point reads the page, so a close that does not come back is not worth waiting
 * for, and closing the browser takes the renderer down anyway.
 */
const orGiveUp = (work, budgetMs) =>
  Promise.race([
    work.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, budgetMs).unref()),
  ]);

const CLOSE_PAGE_BUDGET_MS = 5000;
const CLOSE_BROWSER_BUDGET_MS = 15000;

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
  // A fresh NAVIGATION per width, not one load measured three times. A component that sizes itself
  // on mount keeps the decision it made at the width it mounted at, so a page that was resized
  // under the measurement would report the 390px layout under a 360px key. The viewport is set
  // first and the document is loaded after it, so every reading describes a document that rendered
  // at the width it is filed under. Three navigations per page is what that costs.
  for (const viewport of MOBILE_VIEWPORTS) {
    await page.setViewportSize(viewport);
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
      const reading = await audit(page);
      // The key this reading gets filed under names the width it was taken at, so it has to be the
      // width that was set. A document reporting a different clientWidth means something took the
      // viewport away from the audit, and a reading filed under a width it was not measured at is
      // worse than no reading.
      if (reading.viewport !== viewport.width) {
        unmeasurable.push({
          id: `${spec.id}@${viewport.width}`,
          reason: `viewport set to ${viewport.width}px, document reports ${reading.viewport}px`,
        });
      } else {
        measured.push({ id: spec.id, path: spec.path, width: viewport.width, ...reading });
      }
    } catch (error) {
      unmeasurable.push({
        id: `${spec.id}@${viewport.width}`,
        reason: String(error).slice(0, 160),
      });
    }
  }
  await orGiveUp(page.close(), CLOSE_PAGE_BUDGET_MS);
}

await orGiveUp(browser.close(), CLOSE_BROWSER_BUDGET_MS);

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
  const add = (built) => {
    const existing = byKey.get(built.key);
    if (!existing) {
      byKey.set(built.key, { ...built, occurrences: 1 });
      return;
    }
    existing.occurrences += 1;
    // The WORST of the collapsed siblings, not the first one measured. Keeping the first would let
    // the worst instance hide behind a better one that happened to be walked earlier.
    if (built.magnitude > existing.magnitude) existing.magnitude = built.magnitude;
  };
  for (const page of measured) {
    const overflow = page.scrollWidth > page.viewport + 1;
    if (!overflow && page.wide.length === 0 && page.small.length === 0) continue;

    console.log(`\n${page.id} @ ${page.width}px  (${page.path})`);
    if (overflow) {
      console.log(`  OVERFLOW  scrollWidth ${page.scrollWidth} > viewport ${page.viewport}`);
      add(
        finding(
          "overflow",
          `${page.id}|${page.width}|overflow`,
          { scrollWidth: page.scrollWidth },
          { viewport: page.viewport },
        ),
      );
    }

    // THE COUNT IS THE FINDING; the listing is a convenience. Printing six of eighteen and no total
    // let a reader fix six things and believe they were done — measured at 18 undersized controls on
    // the competition editor, 16 unique, six printed, no number anywhere saying so.
    console.log(
      `  ${page.wide.length} element(s) past the viewport edge, ${page.small.length} ` +
        `undersized control(s) (${page.smallTotal} including repeats)`,
    );
    for (const w of page.wide.slice(0, 6)) {
      console.log(`  WIDE      ${w.descriptor} left=${w.left} right=${w.right}`);
    }
    if (page.wide.length > 6) console.log(`  WIDE      …and ${page.wide.length - 6} more`);
    for (const s of page.small.slice(0, 6)) {
      console.log(`  TARGET    ${s.descriptor} ${s.width}x${s.height}`);
    }
    if (page.small.length > 6) console.log(`  TARGET    …and ${page.small.length - 6} more`);

    // Keyed on the ELEMENT, with the measurement carried as a magnitude rather than folded into
    // the key. Keying on the size would churn on a pixel and nobody would re-take the baseline;
    // carrying no size at all is what let a 40x40 control shrink to 12x12 under a green run.
    for (const w of page.wide) {
      add(
        finding(
          "wide",
          `${page.id}|${page.width}|wide|${w.descriptor}`,
          { right: w.right, left: w.left, viewport: page.viewport },
          { right: w.right, left: w.left },
        ),
      );
    }
    for (const s of page.small) {
      add(
        finding(
          "target",
          `${page.id}|${page.width}|target|${s.descriptor}`,
          { width: s.width, height: s.height },
          { size: `${s.width}x${s.height}` },
        ),
      );
    }
  }

  const findings = [...byKey.values()];
  // One line per width. A single combined total would let a width with nothing wrong carry one that
  // is broken on every page, which is the arithmetic that made 390 look like an answer.
  for (const { width } of MOBILE_VIEWPORTS) {
    const atWidth = measured.filter((page) => page.width === width);
    const dirty = new Set(
      findings.filter((f) => f.key.split("|")[1] === String(width)).map((f) => f.key.split("|")[0]),
    );
    console.log(`\n${atWidth.length - dirty.size}/${atWidth.length} pages clean at ${width}px.`);
  }
  return findings;
};

finishAudit({
  name: "mobile-audit",
  measure,
  unmeasurable,
  note: `${MOBILE_VIEWPORTS.map((v) => v.width).join("/")}px viewports, ${targets.length} pages`,
});
