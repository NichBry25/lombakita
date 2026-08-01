/*
 * Text contrast audit. Walks the page inventory in BOTH themes and measures every visible run of
 * text against the background actually painted behind it, reporting anything under the WCAG AA
 * threshold (4.5:1, or 3:1 for large text per §11 of the brand book).
 *
 * This exists because the failure it catches is invisible to every other check in the pipeline:
 * a token can be correct in light mode, correct in isolation, and pass typecheck, lint and the
 * whole test suite while rendering dark-on-dark for one theme on one surface. Eyes miss it too —
 * the text is still there, just unreadable, and only on the theme you were not looking at.
 *
 * What it cannot do: sample a gradient or an image. Where an ancestor paints one, the finding is
 * marked APPROX and measured against the nearest solid colour instead — reported rather than
 * dropped, because silently skipping is how the gap opens in the first place.
 */
import { launch, contextFor, setTheme, DESKTOP } from "./lib-browser.mjs";
import { PAGES } from "./pages.mjs";
import { BASE, USERS } from "./seeds.mjs";

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const targets = PAGES.filter((p) => !filter || filter.test(p.id));
const THEMES = ["light", "dark"];

const audit = async (page) =>
  page.evaluate(() => {
    const parse = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value ?? "");
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[,/]+/).map((n) => Number.parseFloat(n));
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    };

    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });

    const luminance = ({ r, g, b }) => {
      const ch = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };

    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    // The painted background is whatever survives compositing every translucent layer from the
    // element up to the first fully opaque one. Walking only the nearest ancestor with a colour
    // gets a translucent glass panel wrong by exactly the amount that matters.
    const backgroundOf = (el) => {
      const layers = [];
      let approx = false;
      // A gradient whose stops are all one colour is a solid fill wearing a gradient's clothes.
      // The lime highlighter marker is painted this way, so reading only background-color would
      // measure its text against whatever the marker is covering and report 1:1 for a pairing
      // that is actually 8.37:1.
      const flatFill = (image) => {
        const stops = image.match(/rgba?\([^)]+\)/g);
        if (!stops || stops.length === 0) return null;
        return stops.every((s) => s === stops[0]) ? parse(stops[0]) : null;
      };

      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage && s.backgroundImage !== "none") {
          const flat = flatFill(s.backgroundImage);
          if (flat && flat.a > 0) {
            layers.push(flat);
            if (flat.a === 1) break;
          } else {
            approx = true;
          }
        }
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a === 1) break;
        }
        if (n === document.documentElement) break;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
      return { color: base, approx };
    };

    const describe = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    // The failing element is often a bare <span>; what identifies the bug is the surface it sits
    // on, which is two or three levels up.
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
        parts.unshift(describe(n));
      }
      return parts.join(" > ");
    };

    const hex = ({ r, g, b }) =>
      `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

    const findings = new Map();
    for (const el of document.querySelectorAll("body *")) {
      // Only elements that own text directly — a wrapper inherits its child's problem and would
      // report the same failure once per nesting level.
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (!text) continue;

      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.opacity === "0") continue;
      if (el.closest(".sr-only, .pf-visually-hidden, [hidden]")) continue;
      // A skeleton block is deliberately a shape with no readable content.
      if (el.closest("[aria-busy='true']")) continue;
      // WCAG 1.4.3 exempts text in an inactive component, and the disabled tokens are muted on
      // purpose. Without this the disabled-CTA pattern reports on most of the app and buries the
      // findings that are real.
      if (el.closest(":disabled, [aria-disabled='true']")) continue;

      const fg = parse(s.color);
      if (!fg || fg.a === 0) continue;
      const { color: bg, approx } = backgroundOf(el);
      const painted = fg.a < 1 ? over(fg, bg) : fg;

      const size = Number.parseFloat(s.fontSize);
      const weight = Number.parseInt(s.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(painted, bg);
      if (got >= need) continue;

      const key = `${describe(el)}|${hex(painted)}|${hex(bg)}`;
      if (!findings.has(key)) {
        findings.set(key, {
          el: path(el),
          fg: hex(painted),
          bg: hex(bg),
          ratio: Math.round(got * 100) / 100,
          need,
          approx,
          size: Math.round(size),
          sample: text.slice(0, 40),
        });
      }
    }
    return [...findings.values()].sort((a, b) => a.ratio - b.ratio);
  });

const browser = await launch();
const contexts = new Map();
const report = [];

for (const spec of targets) {
  const key = spec.as ?? "anon";
  if (!contexts.has(key)) {
    contexts.set(key, await contextFor(browser, spec.as ? USERS[spec.as].email : null));
  }
  const page = await contexts.get(key).newPage();
  await page.setViewportSize(DESKTOP);
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
    // The theme switch is a cross-fade. Sampling during it reads blended mid-tones that belong to
    // no token — every colour comes back plausible and slightly wrong, which is worse than an
    // obvious error. Kill transitions so the switch is instantaneous and every reading is settled.
    // A page that redirects (anonymous hitting a guarded route) destroys the context mid-inject;
    // settle and try once more rather than losing the whole page to an error row.
    const freeze = () =>
      page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
    try {
      await freeze();
    } catch {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
      await freeze().catch(() => {});
    }
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(300);
      const found = await audit(page);
      if (found.length) report.push({ id: spec.id, path: spec.path, theme, found });
    }
  } catch (error) {
    report.push({ id: spec.id, path: spec.path, error: String(error).slice(0, 120) });
  }
  await page.close();
}

await browser.close();

for (const entry of report) {
  if (entry.error) {
    console.log(`ERR   ${entry.id.padEnd(34)} ${entry.error}`);
    continue;
  }
  console.log(`\n${entry.id} [${entry.theme}]  (${entry.path})`);
  for (const f of entry.found.slice(0, 8)) {
    const flag = f.approx ? " ~" : "  ";
    console.log(
      `${flag} ${String(f.ratio).padStart(5)}:1 (need ${f.need})  ${f.fg} on ${f.bg}  ` +
        `${f.size}px  ${f.el}  "${f.sample}"`,
    );
  }
}

const pages = new Set(report.filter((r) => !r.error).map((r) => r.id));
console.log(
  `\n${targets.length - pages.size}/${targets.length} pages clean in both themes. ` +
    `~ = measured against a solid colour under a gradient or image; verify by eye.`,
);
