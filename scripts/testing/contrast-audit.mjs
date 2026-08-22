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
 *
 * Three things it does before it will report anything, each of which it used to skip:
 *   - refuses outright unless the browser is loading the stylesheet on disk (lib-css-fingerprint)
 *   - opens collapsed sections, whose contents are ABSENT from the DOM rather than hidden
 *   - fails the run on a page it could not measure, instead of counting it as clean
 */
import { launch, contextFor, setTheme, DESKTOP, settle, expandCollapsibles } from "./lib-browser.mjs";
import { preflightOrRefuse } from "./lib-css-fingerprint.mjs";
import { finishAudit } from "./lib-audit-baseline.mjs";
import { audit } from "./lib-contrast.mjs";
import { toneSeparationFindings } from "./lib-tone-separation.mjs";
import { PAGES } from "./pages.mjs";
import { BASE, USERS } from "./seeds.mjs";

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const targets = PAGES.filter((p) => !filter || filter.test(p.id));
const THEMES = ["light", "dark"];

const browser = await launch();
const contexts = new Map();
const report = [];
const unmeasurable = [];
const measuredPages = new Set();
let preflightDone = false;

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
    // Once, on the first page that loads. Everything measured after this is a statement about the
    // stylesheet the browser holds, and it is only worth making if that is the one on disk.
    if (!preflightDone) {
      await preflightOrRefuse(page, "contrast-audit");
      preflightDone = true;
    }
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
    await expandCollapsibles(page);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(300);
      const found = await audit(page);
      if (found.length) report.push({ id: spec.id, path: spec.path, theme, found });
    }
    measuredPages.add(spec.id);
  } catch (error) {
    unmeasurable.push({ id: spec.id, reason: String(error).slice(0, 160) });
  }
  await page.close();
}

// TONE SEPARATION runs on its own page rather than per surface: the question is whether two
// semantic tones can be told apart from each other, which is a property of the token set, not of
// any one page that happens to render both. See lib-tone-separation.mjs.
const tonePage = await (contexts.get("anon") ?? contexts.values().next().value).newPage();
let toneFindings = [];
try {
  await tonePage.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(tonePage);
  toneFindings = await toneSeparationFindings(tonePage);
} catch (error) {
  unmeasurable.push({ id: "tone-separation", reason: String(error).slice(0, 160) });
}
await tonePage.close();

await browser.close();

/**
 * Prints the report and returns its findings. Called by `finishAudit` only once the run has been
 * established as one that measured everything it claims to describe.
 */
const measure = () => {
  const findings = [];
  for (const entry of report) {
    console.log(`\n${entry.id} [${entry.theme}]  (${entry.path})`);
    console.log(`  ${entry.found.length} pairing(s) under threshold`);
    for (const f of entry.found.slice(0, 8)) {
      const flag = f.approx ? " ~" : "  ";
      console.log(
        `${flag} ${String(f.ratio).padStart(5)}:1 (need ${f.need})  ${f.fg} on ${f.bg}  ` +
          `${f.size}px  ${f.el}  "${f.sample}"`,
      );
    }
    if (entry.found.length > 8) console.log(`   …and ${entry.found.length - 8} more`);
    for (const f of entry.found) {
      findings.push({
        key: `${entry.id}|${entry.theme}|${f.el}|${f.fg}on${f.bg}`,
        ratio: f.ratio,
        need: f.need,
        sample: f.sample,
      });
    }
  }

  if (toneFindings.length > 0) {
    console.log(`\nTONE SEPARATION — ${toneFindings.length} pair(s) too close to tell apart`);
    for (const f of toneFindings) {
      console.log(
        `  [${f.theme}] ${f.a} vs ${f.b}: separation ΔE ${f.separation} (need ${f.need}) — ` +
          `ground ΔE ${f.groundDeltaE}, ink ΔE ${f.textDeltaE}. ${f.detail}`,
      );
      findings.push({ key: `tone|${f.theme}|${f.a}|${f.b}`, ...f });
    }
  }

  const dirtyPages = new Set(report.map((r) => r.id));
  console.log(
    `\n${measuredPages.size - dirtyPages.size}/${measuredPages.size} pages clean in both themes. ` +
      `~ = measured against a solid colour under a gradient or image; verify by eye.`,
  );
  return findings;
};

finishAudit({
  name: "contrast-audit",
  measure,
  unmeasurable,
  note: `${measuredPages.size} pages x light/dark at ${DESKTOP.width}px, plus tone separation`,
});
