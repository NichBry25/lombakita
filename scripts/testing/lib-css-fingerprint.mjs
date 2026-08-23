/*
 * Stylesheet freshness preflight.
 *
 * THE FAILURE THIS EXISTS TO CLOSE. The dev server served CSS compiled 1h43m before the stylesheet
 * it claimed to serve, with a newly added rule absent from every chunk. Nothing in the loop checked
 * that the browser was loading the stylesheet on disk, so every measurement taken that afternoon
 * described a stylesheet that no longer existed — and the audits reported it as fact. A false
 * failure and a false CLEAN are the same defect here: the number is not about the code under test.
 *
 * The instrument is a fingerprint derived FROM THE SOURCES ON DISK and looked for in what the
 * browser actually loaded. Two layers, because they fail independently:
 *
 *   BUILD FRESHNESS  no stylesheet source may be newer than the newest compiled CSS chunk. This
 *                    catches the incident directly and needs no browser: an edit that has not been
 *                    recompiled is visible as a timestamp.
 *   SERVED WITNESSES every selector in the sources must appear in the CSS the page loaded, and
 *                    every design token must resolve, in the browser, to the value on disk.
 *
 * WHAT THIS CANNOT SEE, stated rather than implied: a changed DECLARATION inside an existing rule
 * whose selector and tokens are untouched. Declaration text is not an instrument here — the CSS is
 * run through lightningcss in dev and in production alike, which rewrites `flex: 1 1 auto` to
 * `flex: auto`, drops declarations a later rule overrides, and folds shorthands. Measured over the
 * real build: 3327 source declarations, 24 rewritten past recognition in dev and 30 in production,
 * against 0 of 1153 selectors and 0 of 364 tokens once colour and number formatting are resolved
 * through the browser. Selectors and tokens are the parts a compiler may not rewrite, which is
 * exactly why they make a usable fingerprint. The build-freshness layer covers the declaration case.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Exit code meaning "refused to measure": distinct from 1 (findings) and 2 (crash). */
export const STALE_STYLESHEET_EXIT = 3;

export class StaleStylesheetError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaleStylesheetError";
  }
}

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

/** Every stylesheet the app compiles from. Explicit, so an added file is a deliberate edit here. */
export const STYLESHEET_SOURCES = ["src/app/globals.css", "src/styles/brand-tokens.css"].map((p) =>
  join(REPO_ROOT, p),
);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Canonicalises a selector down to what survives compilation.
 *
 * Whitespace, the quotes inside an attribute selector, and the second colon of a pseudo-element
 * are all formatting the compiler is free to change. A leading universal `*` before a pseudo is
 * dropped outright (`*::before` is emitted as `:before`), so the bare form is accepted too.
 */
export const canonicalSelector = (selector) => {
  let s = selector.replace(/\s+/g, "").toLowerCase();
  s = s.replace(/\[([-a-z0-9_]+)([~^|$*]?=)["']([^"']*)["']\]/g, "[$1$2$3]");
  s = s.replace(/::/g, ":");
  return s;
};

/**
 * Splits a selector list on the commas that separate selectors.
 *
 * Not `String.split(",")`: `:not(a, b)` and `:is(a, b)` carry their own commas, and splitting on
 * those produces fragments like `[data-status=expired]):before` that are absent from every
 * stylesheet ever compiled — a preflight that refuses over its own parse error is worse than none.
 */
const splitSelectorList = (selectorList) => {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of selectorList) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
};

/** Every selector declared across the sources, canonicalised. */
export const sourceSelectors = (sources) => {
  const selectors = new Set();
  for (const { text } of sources) {
    const css = stripComments(text);
    for (const match of css.matchAll(/(?:^|[;{}])\s*([^{}@;]+?)\s*\{/gm)) {
      for (const one of splitSelectorList(match[1])) {
        const canon = canonicalSelector(one);
        if (canon) selectors.add(canon);
      }
    }
  }
  return selectors;
};

/**
 * Every design token declared under `:root` or a `[data-theme=…]` block, split by theme.
 *
 * A token declared in both is recorded under both: the dark block deliberately re-declares a
 * subset of the light one, and the audit reads each theme against its own values.
 */
export const sourceTokens = (sources) => {
  const themes = { light: new Map(), dark: new Map() };
  for (const { text } of sources) {
    const css = stripComments(text);
    for (const block of css.matchAll(/(?:^|[;{}])\s*([^{}@;]+?)\s*\{([^{}]*)\}/gm)) {
      const selector = canonicalSelector(block[1]);
      const isDark = selector.includes("[data-theme=dark]");
      const isLight = selector.includes(":root") || selector.includes("[data-theme=light]");
      if (!isDark && !isLight) continue;
      for (const decl of block[2].matchAll(/(--[-a-z0-9]+)\s*:\s*([^;{}]+);/gi)) {
        const name = decl[1].trim();
        const value = decl[2].trim();
        if (isDark) themes.dark.set(name, value);
        // `:root, [data-theme="light"]` is one block declaring the light palette; the later
        // bare `:root` block declares theme-independent tokens. Both are light-side truth.
        if (isLight) themes.light.set(name, value);
      }
    }
  }
  return themes;
};

export const readStylesheetSources = () =>
  STYLESHEET_SOURCES.map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** Every compiled CSS chunk Next has emitted, wherever it put them. */
const compiledChunks = (dir, found = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "cache") continue;
      compiledChunks(full, found);
    } else if (entry.name.endsWith(".css")) {
      found.push(full);
    }
  }
  return found;
};

/**
 * Refuses when a stylesheet source is newer than everything compiled from it.
 *
 * This is the incident in its plainest form: the source was edited and the compiler never ran, so
 * the newest chunk predates the newest source. Silent when nothing has been compiled yet — a fresh
 * clone has no `.next`, and refusing there would be refusing to measure a tree that is fine.
 */
export const assertBuildIsNewerThanSources = (sources) => {
  const chunks = compiledChunks(join(REPO_ROOT, ".next"));
  if (chunks.length === 0) return;

  const newestChunk = Math.max(...chunks.map((f) => statSync(f).mtimeMs));
  for (const { path } of sources) {
    const sourceMs = statSync(path).mtimeMs;
    if (sourceMs > newestChunk) {
      const behind = Math.round((sourceMs - newestChunk) / 1000);
      throw new StaleStylesheetError(
        `${path} was edited ${behind}s after the newest compiled CSS chunk. The browser cannot be ` +
          `seeing this edit. Let the dev server finish recompiling (or re-run \`npm run build\`) ` +
          `and start again.`,
      );
    }
  }
};

/**
 * Collects every stylesheet the page actually loaded, as one string.
 *
 * Same-origin sheets are read out of `document.styleSheets`, which is what the browser parsed
 * rather than what the network happened to return.
 */
export const servedStylesheetText = async (page) =>
  page.evaluate(() => {
    const parts = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) parts.push(rule.cssText);
      } catch {
        // A cross-origin sheet cannot be read. Google Fonts is the only one, and it declares no
        // selector or token this fingerprint is derived from.
      }
    }
    return parts.join("\n");
  });

/**
 * Resolves each disk token value in the page and compares it with what the page's own stylesheet
 * set that token to.
 *
 * BOTH SIDES GO THROUGH THE BROWSER. `#ffffff` and `#fff`, `rgba(20,69,61,.22)` and `#14453d38`,
 * `200ms` and `.2s` are the same value written differently, and a compiler picks whichever is
 * shorter. Rather than reimplement that equivalence — which is how a preflight starts producing
 * false refusals nobody can explain — each side is handed to the engine and the engine's own
 * canonical form is compared.
 */
const compareTokensInPage = async (page, theme, tokens) =>
  page.evaluate(
    ({ theme, entries }) => {
      const root = document.documentElement;
      const previousTheme = root.dataset.theme;
      root.dataset.theme = theme;

      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      root.appendChild(probe);

      // A compiler is free to write the same number differently — `0.9375rem` as `.9375rem`,
      // `200ms` as `.2s`. Both sides go through this, so the comparison is about the value.
      const normaliseNumbers = (value) =>
        value
          .replace(/(^|[\s,(-])0+(\.\d)/g, "$1$2")
          .replace(/(\d*\.?\d+)s\b/g, (_, seconds) => `${Number(seconds) * 1000}ms`);

      // Colours inside a compound value get rewritten too: a shadow's `rgba(20, 69, 61, 0.05)`
      // comes back as `#14453d0d`. Each colour literal is resolved on its own so the surrounding
      // offsets and blur radii still compare as the text they are.
      const normaliseEmbeddedColours = (value) =>
        value.replace(/#[0-9a-f]{3,8}\b|rgba?\([^()]*\)/gi, (literal) => {
          probe.style.color = "";
          probe.style.color = literal;
          return probe.style.color === "" ? literal : getComputedStyle(probe).color;
        });

      // Resolving through a custom property is what makes `var(--font-dm-sans), system-ui` on disk
      // comparable with the font stack the browser substituted into it: the engine performs the
      // same substitution on the disk text, in the same inherited context.
      const resolveAsCustomProperty = (value) => {
        probe.style.removeProperty("--fingerprint-probe");
        probe.style.setProperty("--fingerprint-probe", value);
        return getComputedStyle(probe).getPropertyValue("--fingerprint-probe").trim();
      };

      // The engine's canonical form of a value, whatever kind of value it is. A colour comes back
      // as `rgb(...)`; anything the colour channel refuses is compared as normalised text.
      const canonical = (value) => {
        const resolved = resolveAsCustomProperty(value);
        probe.style.color = "";
        probe.style.color = resolved;
        if (probe.style.color !== "") return `colour:${getComputedStyle(probe).color}`;
        const flattened = normaliseEmbeddedColours(
          resolved.replace(/\s+/g, " ").trim().toLowerCase(),
        );
        return `text:${normaliseNumbers(flattened)}`;
      };

      const mismatches = [];
      const computed = getComputedStyle(root);
      for (const [name, diskValue] of entries) {
        const served = computed.getPropertyValue(name).trim();
        if (served === "") {
          mismatches.push({ name, disk: diskValue, served: "(not declared)" });
          continue;
        }
        if (canonical(served) !== canonical(diskValue)) {
          mismatches.push({ name, disk: diskValue, served });
        }
      }

      probe.remove();
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
      return mismatches;
    },
    { theme, entries: [...tokens.entries()] },
  );

/**
 * THE PREFLIGHT. Refuses, loudly and before any measurement, when the browser is not seeing the
 * stylesheet on disk.
 *
 * Throws `StaleStylesheetError`; callers exit `STALE_STYLESHEET_EXIT` and print no report, because
 * a report produced against the wrong stylesheet is worse than none — it gets quoted.
 */
export const assertServedCssMatchesSource = async (page) => {
  const sources = readStylesheetSources();
  assertBuildIsNewerThanSources(sources);

  const served = await servedStylesheetText(page);
  if (served.trim() === "") {
    throw new StaleStylesheetError(
      "the page loaded no readable stylesheet at all. Nothing measured here would be about the " +
        "app's own CSS.",
    );
  }
  const servedCanon = canonicalSelector(served);

  const missingSelectors = [];
  for (const selector of sourceSelectors(sources)) {
    if (servedCanon.includes(selector)) continue;
    // `*::before` is emitted as a bare `:before`; the universal is implied.
    if (selector.startsWith("*") && servedCanon.includes(selector.slice(1))) continue;
    missingSelectors.push(selector);
  }

  const tokens = sourceTokens(sources);
  const tokenMismatches = [
    ...(await compareTokensInPage(page, "light", tokens.light)).map((m) => ({
      ...m,
      theme: "light",
    })),
    ...(await compareTokensInPage(page, "dark", tokens.dark)).map((m) => ({ ...m, theme: "dark" })),
  ];

  if (missingSelectors.length === 0 && tokenMismatches.length === 0) return;

  const lines = [];
  if (missingSelectors.length > 0) {
    lines.push(
      `${missingSelectors.length} selector(s) on disk are absent from the CSS the browser loaded:`,
      ...missingSelectors.slice(0, 8).map((s) => `    ${s}`),
    );
  }
  for (const m of tokenMismatches.slice(0, 8)) {
    lines.push(`    [${m.theme}] ${m.name}: disk ${m.disk} — browser ${m.served}`);
  }
  if (tokenMismatches.length > 8) {
    lines.push(`    …and ${tokenMismatches.length - 8} more token mismatch(es)`);
  }
  throw new StaleStylesheetError(
    `the browser is not seeing the stylesheet on disk.\n${lines.join("\n")}`,
  );
};

/**
 * Wraps the preflight so every audit refuses the same way: one banner, one exit code, no report.
 */
export const preflightOrRefuse = async (page, auditName) => {
  try {
    await assertServedCssMatchesSource(page);
  } catch (error) {
    if (!(error instanceof StaleStylesheetError)) throw error;
    console.error(
      `\nSTYLESHEET PREFLIGHT REFUSED — ${auditName} measured nothing.\n` +
        `${error.message}\n\n` +
        `No report was produced. A measurement taken against a stylesheet the source no longer ` +
        `matches describes an app that does not exist, and it gets quoted as if it did.`,
    );
    process.exit(STALE_STYLESHEET_EXIT);
  }
};
