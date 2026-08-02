/*
 * UAT-T1 — audits the contrast auditor.
 *
 * contrast-audit.mjs is the only check standing between the app and an entire theme rendering
 * dark-on-dark, and nothing verified that it CATCHES anything. Its findings were all confirmed by
 * hand once, but a refactor that broke the measurement would leave every page reporting clean and
 * the pipeline would say nothing — the failure mode is silence, which is why it needs its own test.
 *
 * This drives the real `audit()` against a synthetic page of hand-computed pairings and asserts
 * both what it reports and what it declines to report. Ratios are checked to two decimal places,
 * not merely "a finding exists": the cases below are chosen so that a plausible-but-wrong
 * implementation still produces a finding, just with the wrong number.
 *
 * Usage: node scripts/testing/contrast-audit-selftest.mjs
 * Needs no dev server and no database — the fixture is set with page.setContent().
 * Exit code: 0 when every assertion holds; 1 otherwise.
 */
import { launch } from "./lib-browser.mjs";
import { audit } from "./lib-contrast.mjs";

let failures = 0;
const check = (condition, label) => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
};

// Every pairing below is computed from the WCAG relative-luminance formula, independently of the
// implementation under test. `id` matches the fixture element's id so a finding can be located.
const EXPECTED_FAILURES = [
  { id: "normal-fail", ratio: 4.48, need: 4.5, note: "#777 on white, 16px — just under AA" },
  { id: "normal-fail-mid", ratio: 3.03, need: 4.5, note: "#949494 on white at body size" },
  {
    id: "composited",
    ratio: 3.98,
    need: 4.5,
    note: "white on 50%-alpha black over white — the ratio proves layers were composited, not skipped",
  },
];

const EXPECTED_CLEAN = [
  { id: "normal-pass", note: "#767676 on white, 16px — 4.54:1, just over AA" },
  { id: "large-pass", note: "#949494 on white at 32px — 3.03:1 clears the large-text threshold" },
  { id: "flat-gradient", note: "palm on a flat lime gradient — 8.37:1, must read the marker fill" },
  { id: "excluded-disabled", note: "blatant fail inside [aria-disabled] — WCAG 1.4.3 exempt" },
  { id: "excluded-sronly", note: "blatant fail inside .sr-only — not visible to anyone" },
  { id: "excluded-skeleton", note: "blatant fail inside [aria-busy] — a shape, not content" },
];

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; font-family: sans-serif; }
  p { margin: 0; padding: 4px; font-size: 16px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; }
</style></head><body>
  <p id="normal-fail" style="color:#777777">Kirim berkas</p>
  <p id="normal-pass" style="color:#767676">Kirim berkas</p>
  <p id="normal-fail-mid" style="color:#949494">Kirim berkas</p>
  <p id="large-pass" style="color:#949494;font-size:32px">Kirim berkas</p>

  <!-- A translucent layer over white. Reading only the nearest ancestor's background-color finds
       'transparent', skips to white, and reports white-on-white at 1:1 — a finding with the wrong
       number. The composited answer is #808080, giving 3.98:1. -->
  <div style="background:rgba(0,0,0,0.5)">
    <p id="composited" style="color:#ffffff">Kirim berkas</p>
  </div>

  <!-- The lime highlighter marker is painted as a gradient whose stops are all one colour. Reading
       background-color alone would measure against the dark band behind it. -->
  <div style="background:#14453d;padding:8px">
    <p id="flat-gradient"
       style="color:#14453d;background-image:linear-gradient(#d0f05e,#d0f05e)">Kirim berkas</p>
  </div>

  <button id="excluded-disabled" aria-disabled="true" style="color:#eeeeee;background:#ffffff">
    Kirim berkas
  </button>
  <p id="excluded-sronly" class="sr-only" style="color:#eeeeee">Kirim berkas</p>
  <div aria-busy="true"><p id="excluded-skeleton" style="color:#eeeeee">Kirim berkas</p></div>
</body></html>`;

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.setContent(FIXTURE, { waitUntil: "domcontentloaded" });

const found = await audit(page);
await browser.close();

// `audit` identifies findings by a CSS-ish path rather than by id, so match on the id appearing in
// that path. The trailing boundary is required: a plain `includes("#normal-fail")` also matches
// `#normal-fail-mid`, which silently attributes one element's finding to another.
const idPattern = (id) => new RegExp(`#${id}(?![-\\w])`);
const findingFor = (id) => found.find((f) => idPattern(id).test(f.el));

console.log(`\n[reports the failures] ${EXPECTED_FAILURES.length} pairings that must be caught`);
for (const expected of EXPECTED_FAILURES) {
  const finding = findingFor(expected.id);
  if (!finding) {
    check(false, `${expected.id} — NOT REPORTED (${expected.note})`);
    continue;
  }
  const ratioMatches = Math.abs(finding.ratio - expected.ratio) < 0.02;
  check(
    ratioMatches && finding.need === expected.need,
    `${expected.id} — ${finding.ratio}:1 (need ${finding.need}) [want ~${expected.ratio}:1 need ${expected.need}] — ${expected.note}`,
  );
}

console.log(`\n[declines the rest] ${EXPECTED_CLEAN.length} pairings that must NOT be reported`);
for (const expected of EXPECTED_CLEAN) {
  const finding = findingFor(expected.id);
  check(
    finding === undefined,
    `${expected.id} — ${finding ? `WRONGLY REPORTED at ${finding.ratio}:1` : "clean"} — ${expected.note}`,
  );
}

// A finding on an element the fixture does not name means the auditor is measuring something the
// fixture did not intend to test, which invalidates the reasoning above rather than merely adding
// noise.
const named = [...EXPECTED_FAILURES, ...EXPECTED_CLEAN].map((e) => e.id);
const unexpected = found.filter((f) => !named.some((id) => idPattern(id).test(f.el)));
console.log(`\n[no strays]`);
check(
  unexpected.length === 0,
  `no findings outside the fixture's named elements${
    unexpected.length ? ` (got ${unexpected.map((f) => `${f.el} @ ${f.ratio}:1`).join("; ")})` : ""
  }`,
);

console.log(
  `\n${failures === 0 ? "ALL CONTRAST SELF-TEST CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
