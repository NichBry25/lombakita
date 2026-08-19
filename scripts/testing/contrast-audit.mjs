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
import { launch, contextFor, setTheme, DESKTOP, settle } from "./lib-browser.mjs";
import { audit } from "./lib-contrast.mjs";
import { PAGES } from "./pages.mjs";
import { BASE, USERS } from "./seeds.mjs";

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const targets = PAGES.filter((p) => !filter || filter.test(p.id));
const THEMES = ["light", "dark"];

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
    await settle(page);
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
