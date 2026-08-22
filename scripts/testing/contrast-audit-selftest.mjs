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
import { launch, expandCollapsibles } from "./lib-browser.mjs";
import { audit } from "./lib-contrast.mjs";
import { MIN_TONE_SEPARATION, toneSeparationFindings } from "./lib-tone-separation.mjs";

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
    id: "reported-label-wrapping-enabled",
    ratio: 3.03,
    need: 4.5,
    note: "label wrapping an ENABLED input — the exemption must not swallow a live control's text",
  },
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
  {
    id: "excluded-label-wrapping-disabled",
    note: "label WRAPPING a disabled input — closest() walks ancestors and never reached it",
  },
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

  <!-- The checkbox row, in both states. The text belongs to the LABEL, which WRAPS the control
       rather than descending from it, so an ancestor walk from the text never meets the input. The
       pair is the point: exempting by ancestry alone reports both, and exempting the label
       unconditionally reports neither. -->
  <label id="excluded-label-wrapping-disabled" style="color:#949494">
    <input type="checkbox" disabled />Kirim berkas
  </label>
  <label id="reported-label-wrapping-enabled" style="color:#949494">
    <input type="checkbox" />Kirim berkas
  </label>
</body></html>`;

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.setContent(FIXTURE, { waitUntil: "domcontentloaded" });

const found = await audit(page);

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

// ---------------------------------------------------------------- collapsibles
//
// A collapsed section is ABSENT from the DOM, not hidden, so everything inside one was measured as
// clean without ever being looked at. The fixture holds a blatant failure inside each of the two
// shapes the app uses, and neither is reachable until the section is opened.
const COLLAPSIBLE_FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; font-family: sans-serif; }
  p { margin: 0; font-size: 16px; }
</style></head><body>
  <details>
    <summary>Rincian</summary>
    <p id="inside-details" style="color:#eeeeee">Kirim berkas</p>
  </details>
  <button type="button" aria-expanded="false" onclick="
    this.setAttribute('aria-expanded','true');
    document.getElementById('slot').innerHTML =
      '<p id=\\'inside-toggled\\' style=\\'color:#eeeeee\\'>Kirim berkas</p>';
  ">Buka formulir</button>
  <div id="slot"></div>
</body></html>`;

const collapsiblePage = await context.newPage();
await collapsiblePage.setContent(COLLAPSIBLE_FIXTURE, { waitUntil: "domcontentloaded" });

console.log(`\n[opens what is collapsed] the conditionally rendered section is the one that hides`);
const beforeOpening = await audit(collapsiblePage);

// THE LOAD-BEARING CASE. `{expanded ? <form/> : null}` renders nothing at all, so there is no
// element to measure and the audit reported the page clean without having seen the form.
check(
  !beforeOpening.some((f) => idPattern("inside-toggled").test(f.el)),
  "inside-toggled — nothing to measure while the section is not rendered",
);

// The other shape behaves differently, and the difference is worth pinning rather than assuming:
// Chromium keeps a closed <details>'s contents laid out, so they were always measurable — which
// means the audit has been reporting text in that position that no reader could see.
check(
  beforeOpening.some((f) => idPattern("inside-details").test(f.el)),
  "inside-details — a CLOSED <details> still exposes its contents to measurement in Chromium",
);

await expandCollapsibles(collapsiblePage);
const afterOpening = await audit(collapsiblePage);
for (const id of ["inside-details", "inside-toggled"]) {
  check(
    afterOpening.some((f) => idPattern(id).test(f.el)),
    `${id} — reported once the section is open`,
  );
}
await collapsiblePage.close();

// ---------------------------------------------------------------- tone separation
//
// The detector answers a question contrast cannot: whether two tones can be told apart FROM EACH
// OTHER. Both fixtures below pass contrast on every pairing — the point is that passing contrast
// says nothing about this.
const toneFixture = (tones) => `<!doctype html><html><head><meta charset="utf-8"><style>
  :root {
${Object.entries(tones)
  .map(([name, [surface, ink]]) =>
    `    --color-${name}-surface: ${surface};\n    --color-${name}-text: ${ink};`,
  )
  .join("\n")}
    --color-inset: #f4eee0;
    --color-ink-soft: #3d5c56;
  }
</style></head><body></body></html>`;

// Two tones one step apart in lightness, same hue: the shape of the info/success collision.
const COLLIDING = {
  success: ["#d9ead9", "#1c5f52"],
  warning: ["#ffd3b0", "#8f3512"],
  error: ["#ffe9da", "#9b3617"],
  info: ["#dceadc", "#1e6154"],
  disabled: ["#f0ebdd", "#5c7571"],
};

// The same set with `info` moved to a genuinely different colour.
const SEPARATED = {
  ...COLLIDING,
  info: ["#d6e4f5", "#1f4b7a"],
};

const tonePage = await context.newPage();

console.log(`\n[tone separation] catches a collision contrast cannot see`);
await tonePage.setContent(toneFixture(COLLIDING), { waitUntil: "domcontentloaded" });
const collided = await toneSeparationFindings(tonePage);
const successInfo = collided.find(
  (f) => f.theme === "light" && [f.a, f.b].includes("success") && [f.a, f.b].includes("info"),
);
check(
  successInfo !== undefined,
  `success vs info is reported${successInfo ? ` at ΔE ${successInfo.separation} (need ${MIN_TONE_SEPARATION})` : ""}`,
);

await tonePage.setContent(toneFixture(SEPARATED), { waitUntil: "domcontentloaded" });
const separated = await toneSeparationFindings(tonePage);
check(
  !separated.some(
    (f) => f.theme === "light" && [f.a, f.b].includes("success") && [f.a, f.b].includes("info"),
  ),
  "the same pair is NOT reported once info moves to a different colour",
);
// Every pair NOT involving `info` is identical between the two fixtures, so its verdict must be
// identical too. Without this the first check passes on a detector that simply reports less.
const withoutInfo = (findings) =>
  findings
    .filter((f) => f.a !== "info" && f.b !== "info")
    .map((f) => `${f.theme}|${f.a}|${f.b}`)
    .sort()
    .join(",");
check(
  withoutInfo(separated) === withoutInfo(collided),
  `the pairs that did not change are judged the same (${withoutInfo(collided) || "none"})`,
);
await tonePage.close();

await browser.close();

console.log(
  `\n${failures === 0 ? "ALL CONTRAST SELF-TEST CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
