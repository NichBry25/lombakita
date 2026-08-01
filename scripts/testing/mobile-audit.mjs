/*
 * Mobile layout audit. Walks the page inventory at phone width and reports the three faults that
 * are measurable rather than a matter of taste:
 *
 *   overflow  — the document scrolls horizontally, which nothing on a phone should do
 *   wide      — an element extends past the viewport edge (the "too close to the border" report)
 *   target    — an interactive control smaller than the 44x44px minimum (ui-preferences §11)
 *
 * Taste still needs eyes; this finds the things eyes miss and proves the fixes landed.
 */
import { launch, contextFor, MOBILE } from "./lib-browser.mjs";
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
    };
  });

const browser = await launch();
const contexts = new Map();
const findings = [];

for (const spec of targets) {
  const key = spec.as ?? "anon";
  if (!contexts.has(key)) {
    contexts.set(key, await contextFor(browser, spec.as ? USERS[spec.as].email : null));
  }
  const page = await contexts.get(key).newPage();
  await page.setViewportSize(MOBILE);
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Heavy forms measure mid-layout at shorter waits and report phantom 25px-tall inputs. Always
    // re-run a flagged page on its own before believing it; in dev a cold compile can also time a
    // page out entirely.
    await page.waitForTimeout(1600);
    const r = await audit(page);
    const overflow = r.scrollWidth > r.viewport + 1;
    if (overflow || r.wide.length || r.small.length) {
      findings.push({ id: spec.id, path: spec.path, overflow, ...r });
    }
  } catch (error) {
    findings.push({ id: spec.id, path: spec.path, error: String(error).slice(0, 120) });
  }
  await page.close();
}

await browser.close();

let clean = 0;
for (const f of findings) {
  if (f.error) {
    console.log(`ERR   ${f.id.padEnd(34)} ${f.error}`);
    continue;
  }
  console.log(`\n${f.id}  (${f.path})`);
  if (f.overflow) console.log(`  OVERFLOW  scrollWidth ${f.scrollWidth} > viewport ${f.viewport}`);
  for (const w of f.wide.slice(0, 6)) console.log(`  WIDE      ${w}`);
  for (const s of f.small.slice(0, 6)) console.log(`  TARGET    ${s}`);
}
clean = targets.length - findings.length;
console.log(`\n${clean}/${targets.length} pages clean at ${MOBILE.width}px.`);
