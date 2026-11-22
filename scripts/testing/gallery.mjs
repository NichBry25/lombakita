/**
 * Design gallery: every page in every reachable mode × light/dark × desktop/mobile.
 * Writes PNGs to test-artifacts/gallery/<id>/ plus index.md and gallery.json.
 *
 * Resumable: a page whose four PNGs already exist is skipped unless FORCE=1. The browser is
 * recycled every RECYCLE pages because a long full-page capture run exhausts Chrome's memory.
 *
 *   node gallery.mjs            # capture everything missing
 *   node gallery.mjs "^5"       # only ids matching the regex
 *   FORCE=1 node gallery.mjs    # recapture even if PNGs exist
 *
 * Environment:
 *   GALLERY_OUT          output folder (default test-artifacts/gallery; a width run needs it)
 *   GALLERY_DRY_RUN=1    print how many shots the run would take, per page and in total; capture nothing
 *   GALLERY_WIDTHS       comma-separated WIDTHxHEIGHT, e.g. 1440x900,1024x768,768x1024,390x844.
 *                        Captures PAGES and STATE_PAGES at those sizes as
 *                        <output>/<page>/<role or anon>__<theme>__<width>.png, skips a role whose
 *                        shot below the site header is pixel-identical to an earlier role's, and
 *                        enables the two settings below
 *   GALLERY_THEMES       comma-separated, light and dark (default both)
 *   GALLERY_START_HERE=1 also write one 1440x900 and one 390x844 light shot of every entry without a
 *                        state into <output>/start-here/
 */
import { createHash } from "crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { launch, contextFor, setTheme, visit, shot, DESKTOP, MOBILE } from "./lib-browser.mjs";
import { PAGES } from "./pages.mjs";
import { STATE_PAGES } from "./state-pages.mjs";
import { USERS } from "./seeds.mjs";

const REPO = "/Users/nikau/Developer/lombakita";
const OUT = process.env.GALLERY_OUT
  ? resolve(process.env.GALLERY_OUT)
  : `${REPO}/test-artifacts/gallery`;
const STATE = `${OUT}/gallery.json`;
const MODES = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];
const RECYCLE = 12;
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const force = process.env.FORCE === "1";
const dryRun = process.env.GALLERY_DRY_RUN === "1";

const THEMES = ["light", "dark"];
const START_HERE_DIR = "start-here";
const START_HERE_SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const START_HERE_THEME = "light";
const SITE_HEADER = "header.site-header";

const loadState = () => {
  try {
    return new Map(JSON.parse(readFileSync(STATE, "utf8")).map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
};

const matchesFilter = (p) => !only || only.test(p.id) || only.test(p.path);

const contextOf = async (browser, contexts, p) => {
  const key = p.as ?? "anon";
  if (!contexts.has(key))
    contexts.set(key, await contextFor(browser, p.as ? USERS[p.as].email : null));
  return contexts.get(key);
};

const openPage = async (context) => {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  return { page, consoleErrors };
};

const visitOutcome = (p, r, consoleErrors) => {
  const base = p.path.split("?")[0];
  const redirected = Boolean(r.url) && !r.url.includes(base);
  return {
    status: r.status,
    finalUrl: r.url,
    redirected,
    consoleErrors: [...new Set(consoleErrors)],
    error: null,
  };
};

const capturePage = async (browser, contexts, p) => {
  const context = await contextOf(browser, contexts, p);
  const { page, consoleErrors } = await openPage(context);

  const dir = `${OUT}/${p.id}`;
  mkdirSync(dir, { recursive: true });
  try {
    await page.setViewportSize(DESKTOP);
    const r = await visit(page, p.path);
    await setTheme(page, "light");
    await shot(page, `${dir}/desktop-light.png`);
    await setTheme(page, "dark");
    await shot(page, `${dir}/desktop-dark.png`);
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300);
    await shot(page, `${dir}/mobile-dark.png`);
    await setTheme(page, "light");
    await shot(page, `${dir}/mobile-light.png`);

    return { ...p, ...visitOutcome(p, r, consoleErrors) };
  } finally {
    await page.close().catch(() => {});
  }
};

/**
 * Captures every target in order, resumably: `isDone` skips an entry already captured and `onSkip`
 * sees each skipped entry, the browser is recycled every RECYCLE entries, and an entry is retried
 * once before its error is recorded.
 */
const captureAll = async (targets, state, { isDone, capture, onSkip = () => {} }) => {
  let browser = await launch();
  let contexts = new Map();
  let sinceRecycle = 0;

  for (const p of targets) {
    if (isDone(p)) {
      onSkip(p);
      console.log(`skip ${p.id}`);
      continue;
    }
    if (sinceRecycle >= RECYCLE) {
      await browser.close().catch(() => {});
      browser = await launch();
      contexts = new Map();
      sinceRecycle = 0;
      console.log("--- browser recycled ---");
    }

    let row = null;
    for (let attempt = 1; attempt <= 2 && !row; attempt += 1) {
      try {
        row = await capture(browser, contexts, p);
      } catch (e) {
        const msg = String(e).slice(0, 200);
        if (attempt === 2) {
          row = {
            ...state.get(p.id),
            ...p,
            status: 0,
            finalUrl: "",
            redirected: false,
            consoleErrors: [],
            error: msg,
          };
        } else {
          console.log(`retry ${p.id} after: ${msg}`);
          // A crashed browser cannot be reused; rebuild before the second attempt.
          await browser.close().catch(() => {});
          browser = await launch();
          contexts = new Map();
        }
      }
    }
    sinceRecycle += 1;
    state.set(p.id, row);
    writeFileSync(STATE, JSON.stringify([...state.values()], null, 2));
    console.log(
      `${row.error ? "ERR " : "ok  "} ${p.id.padEnd(34)} ${String(row.status).padEnd(4)} ${row.redirected ? "→ " + row.finalUrl.replace("http://localhost:3000", "") : ""}${row.consoleErrors.length ? "  [console:" + row.consoleErrors.length + "]" : ""}${row.error ? "  " + row.error : ""}`,
    );
  }

  await browser.close().catch(() => {});
};

const notesOf = (r) =>
  [
    r.redirected ? `redirected → \`${r.finalUrl.replace("http://localhost:3000", "")}\`` : "",
    r.consoleErrors.length ? `${r.consoleErrors.length} console error(s)` : "",
    r.error ? `CAPTURE ERROR: ${r.error}` : "",
  ]
    .filter(Boolean)
    .join("; ");

const consoleErrorSection = (rows) => [
  "## Console errors seen during capture",
  "",
  ...rows
    .filter((r) => r.consoleErrors.length)
    .flatMap((r) => [
      `**${r.id}** \`${r.path}\``,
      ...r.consoleErrors.map((e) => `- \`${e.replaceAll("|", "/")}\``),
      "",
    ]),
];

const writeDefaultIndex = (state) => {
  const rows = PAGES.map((p) => state.get(p.id)).filter(Boolean);
  const md = [
    "# Design Gallery",
    `Captured ${new Date().toISOString()} — ${rows.length} pages × 4 modes (desktop/mobile × light/dark).`,
    "",
    "Each row links its four PNGs. `as` is the session used. A redirect target in the last column",
    "means a route guard moved you — that is behavior, not a broken capture.",
    "",
    "| # | Page | As | HTTP | Shots | Notes |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const shots = MODES.map(
        (m) => `[${m.replace("desktop-", "D-").replace("mobile-", "M-")}](${r.id}/${m}.png)`,
      ).join(" · ");
      return `| ${r.id} | ${r.label}<br/>\`${r.path}\` | ${r.as ?? "signed out"} | ${r.status} | ${shots} | ${notesOf(r)} |`;
    }),
    "",
    ...consoleErrorSection(rows),
  ].join("\n");
  writeFileSync(`${OUT}/index.md`, md);
  return rows.length;
};

const runDefault = async () => {
  const targets = PAGES.filter(matchesFilter);
  if (dryRun) {
    printDryRun(
      targets.map((p) => ({ id: p.id, shots: MODES })),
      "",
    );
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const state = loadState();
  const isDone = (p) => {
    const done = MODES.every((m) => existsSync(`${OUT}/${p.id}/${m}.png`));
    return done && !force && state.has(p.id) && !state.get(p.id).error;
  };
  await captureAll(targets, state, { isDone, capture: capturePage });

  const recorded = writeDefaultIndex(state);
  console.log(`\nGallery: ${recorded} pages recorded → ${OUT}/index.md`);
};

// ---------------------------------------------------------------- GALLERY_WIDTHS run

const parseSizes = (setting) =>
  setting.split(",").map((part) => {
    const match = part.trim().match(/^(\d+)x(\d+)$/);
    if (!match) throw new Error(`GALLERY_WIDTHS: "${part}" is not WIDTHxHEIGHT`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });

const parseThemes = (setting) =>
  setting.split(",").map((part) => {
    const theme = part.trim();
    if (!THEMES.includes(theme)) throw new Error(`GALLERY_THEMES: "${part}" is not light or dark`);
    return theme;
  });

const sizeLabel = (size) => `${size.width}x${size.height}`;
const roleOf = (p) => p.as ?? "anon";
// The roles of one page and state share a folder: the id without its `--<role>` part.
const folderOf = (p) => p.id.split("--")[0];
const fileOf = (p, theme, size) => `${folderOf(p)}/${roleOf(p)}__${theme}__${size.width}.png`;
const duplicateKeyOf = (p, theme, size) =>
  `${p.path}|${p.state ?? "default"}|${size.width}|${theme}`;

/**
 * The shots one entry takes, grouped by size and then by theme, so each size is loaded once.
 * `main` shots go to the run's folder and take part in the duplicate check; `startHere` shots are
 * written whatever an earlier role looked like.
 */
const shotPlanOf = (p, run) => {
  const bySize = new Map();
  const add = (size, theme, kind) => {
    const label = sizeLabel(size);
    if (!bySize.has(label)) bySize.set(label, { size, themes: new Map() });
    const themes = bySize.get(label).themes;
    if (!themes.has(theme)) themes.set(theme, { main: false, startHere: false });
    themes.get(theme)[kind] = true;
  };
  for (const size of run.sizes) {
    for (const theme of run.themes) add(size, theme, "main");
  }
  if (run.startHere && !p.state) {
    for (const size of START_HERE_SIZES) add(size, START_HERE_THEME, "startHere");
  }
  return [...bySize.values()];
};

const plannedShotsOf = (plan) =>
  plan.flatMap(({ size, themes }) =>
    [...themes.entries()].flatMap(([theme, kinds]) => [
      ...(kinds.main ? [`${sizeLabel(size)} ${theme}`] : []),
      ...(kinds.startHere ? [`${START_HERE_DIR} ${sizeLabel(size)} ${theme}`] : []),
    ]),
  );

/** sha256 of the full-page shot below the site header, which is what the duplicate check compares. */
const hashBelowHeader = async (page) => {
  const area = await page.evaluate((selector) => {
    const header = document.querySelector(selector);
    const top = header ? header.getBoundingClientRect().bottom + window.scrollY : 0;
    return {
      top: Math.ceil(top),
      width: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
    };
  }, SITE_HEADER);
  const below = Math.max(area.height - area.top, 1);
  const png = await page.screenshot({
    fullPage: true,
    animations: "disabled",
    clip: { x: 0, y: Math.min(area.top, area.height - 1), width: area.width, height: below },
  });
  return createHash("sha256").update(png).digest("hex");
};

// A shot never counts as the same as its own file, which a retried entry may already have written.
const keptShotOf = (kept, key, hash, file) =>
  (kept.get(key) ?? []).find((k) => k.hash === hash && k.file !== file);

const forgetKeptShot = (kept, key, file) => {
  const others = (kept.get(key) ?? []).filter((k) => k.file !== file);
  kept.set(key, others);
};

const rememberKeptShot = (kept, key, file, hash) => {
  forgetKeptShot(kept, key, file);
  kept.get(key).push({ file, hash });
};

const writeShotFile = (file, png) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
};

const takeShot = async (page, p, theme, size, kinds, kept) => {
  const png = await page.screenshot({ fullPage: true, animations: "disabled" });
  const file = fileOf(p, theme, size);
  let record = null;

  if (kinds.main) {
    const key = duplicateKeyOf(p, theme, size);
    const hash = await hashBelowHeader(page);
    const earlier = keptShotOf(kept, key, hash, file);
    if (earlier) {
      forgetKeptShot(kept, key, file);
      // An earlier run may have written this role's own picture; the index now points elsewhere.
      rmSync(`${OUT}/${file}`, { force: true });
      record = { file, size: sizeLabel(size), theme, hash, sameAs: earlier.file };
    } else {
      writeShotFile(`${OUT}/${file}`, png);
      rememberKeptShot(kept, key, file, hash);
      record = { file, size: sizeLabel(size), theme, hash, sameAs: null };
    }
  }
  if (kinds.startHere) {
    writeShotFile(`${OUT}/${START_HERE_DIR}/${file}`, png);
  }
  return { record, startHere: kinds.startHere ? { file, size: sizeLabel(size), theme } : null };
};

const sameShot = (a, b) => a.size === b.size && a.theme === b.theme;

const mergeShots = (earlier, fresh) => [
  ...(earlier ?? []).filter((old) => !fresh.some((shotRecord) => sameShot(old, shotRecord))),
  ...fresh,
];

const captureEntryAtSizes = async (browser, contexts, p, run, kept, earlierRow) => {
  const context = await contextOf(browser, contexts, p);
  const { page, consoleErrors } = await openPage(context);
  const shots = [];
  const startHere = [];
  let firstVisit = null;

  try {
    for (const { size, themes } of shotPlanOf(p, run)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      let loaded = false;
      for (const [theme, kinds] of themes) {
        // An interaction leaves the page in the state it shows, so it is replayed on a fresh load
        // before each theme rather than carried over from the previous shot.
        if (!loaded || p.interact) {
          const r = await visit(page, p.path);
          firstVisit ??= r;
          if (p.interact) {
            await p.interact(page);
            await page.waitForTimeout(500);
          }
          loaded = true;
        }
        await setTheme(page, theme);
        const taken = await takeShot(page, p, theme, size, kinds, kept);
        if (taken.record) shots.push(taken.record);
        if (taken.startHere) startHere.push(taken.startHere);
      }
    }
    return {
      ...p,
      ...visitOutcome(p, firstVisit, consoleErrors),
      shots: mergeShots(earlierRow?.shots, shots),
      startHere: mergeShots(earlierRow?.startHere, startHere),
    };
  } finally {
    await page.close().catch(() => {});
  }
};

const isCapturedAtSizes = (p, row, run) => {
  if (!row || row.error || force) return false;
  return shotPlanOf(p, run).every(({ size, themes }) =>
    [...themes.entries()].every(([theme, kinds]) => {
      const wanted = { size: sizeLabel(size), theme };
      const main =
        !kinds.main ||
        (row.shots ?? []).some(
          // A filtered FORCE=1 run can delete the picture a "same as" row names.
          (s) => sameShot(s, wanted) && existsSync(`${OUT}/${s.sameAs ?? s.file}`),
        );
      const startHere =
        !kinds.startHere || existsSync(`${OUT}/${START_HERE_DIR}/${fileOf(p, theme, size)}`);
      return main && startHere;
    }),
  );
};

// A skipped entry still holds the shots later roles are compared against.
const rememberRecordedShots = (kept, p, row) => {
  for (const s of row.shots ?? []) {
    if (s.sameAs) continue;
    const [width] = s.size.split("x");
    rememberKeptShot(kept, duplicateKeyOf(p, s.theme, { width }), s.file, s.hash);
  }
};

const writeSizesIndex = (state, run) => {
  const rows = [...PAGES, ...STATE_PAGES].map((p) => state.get(p.id)).filter(Boolean);
  const shotLine = (r, s) =>
    `| ${s.sameAs ? "—" : `[${s.file}](${s.file})`} | ${folderOf(r)}<br/>\`${r.path}\` | ${roleOf(r)} | ${r.state ?? "default"} | ${s.theme} | ${s.size.split("x")[0]} | ${s.sameAs ? `same as ${s.sameAs}` : ""} | ${r.status} | ${notesOf(r)} |`;
  const startHereLines = rows.flatMap((r) =>
    (r.startHere ?? []).map(
      (s) =>
        `| [${s.file}](${START_HERE_DIR}/${s.file}) | ${folderOf(r)}<br/>\`${r.path}\` | ${roleOf(r)} | ${s.theme} | ${s.size.split("x")[0]} |`,
    ),
  );
  const md = [
    "# Design Gallery",
    `Captured ${new Date().toISOString()} — ${rows.length} entries at ${run.sizes.map(sizeLabel).join(", ")} × ${run.themes.join("/")}.`,
    "",
    "One row per shot. A shot whose content below the site header is pixel-identical to an earlier",
    "role's shot of the same page, state, width and theme is not written; its row names that file.",
    "A redirect target in the last column means a route guard moved you — that is behavior, not a",
    "broken capture.",
    "",
    "| File | Page | Role | State | Theme | Width | Same as | HTTP | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.flatMap((r) =>
      (r.shots ?? []).length
        ? r.shots.map((s) => shotLine(r, s))
        : [
            `| — | ${folderOf(r)}<br/>\`${r.path}\` | ${roleOf(r)} | ${r.state ?? "default"} | | | | ${r.status} | ${notesOf(r)} |`,
          ],
    ),
    "",
    ...(startHereLines.length
      ? [
          "## Start here",
          "",
          "| File | Page | Role | Theme | Width |",
          "|---|---|---|---|---|",
          ...startHereLines,
          "",
        ]
      : []),
    ...consoleErrorSection(rows),
  ].join("\n");
  writeFileSync(`${OUT}/index.md`, md);
  return rows.length;
};

const runAtSizes = async (run) => {
  const targets = [...PAGES, ...STATE_PAGES].filter(matchesFilter);
  if (dryRun) {
    printDryRun(
      targets.map((p) => ({ id: p.id, shots: plannedShotsOf(shotPlanOf(p, run)) })),
      " A real run writes fewer when a role's shot repeats an earlier role's.",
    );
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const state = loadState();
  const kept = new Map();
  const isDone = (p) => isCapturedAtSizes(p, state.get(p.id), run);
  const onSkip = (p) => rememberRecordedShots(kept, p, state.get(p.id));
  const capture = (browser, contexts, p) =>
    captureEntryAtSizes(browser, contexts, p, run, kept, state.get(p.id));
  await captureAll(targets, state, { isDone, capture, onSkip });

  const recorded = writeSizesIndex(state, run);
  console.log(`\nGallery: ${recorded} entries recorded → ${OUT}/index.md`);
};

// ---------------------------------------------------------------- dry run

const printDryRun = (entries, closingNote) => {
  const perMode = new Map();
  for (const { id, shots } of entries) {
    console.log(`${id.padEnd(90)} ${shots.length}`);
    for (const mode of shots) perMode.set(mode, (perMode.get(mode) ?? 0) + 1);
  }
  const total = entries.reduce((sum, entry) => sum + entry.shots.length, 0);
  console.log("");
  for (const [mode, count] of perMode) console.log(`${mode.padEnd(30)} ${count}`);
  console.log(
    `\nDry run: ${total} shots across ${entries.length} entries. Nothing was captured.${closingNote}`,
  );
};

const main = async () => {
  const widthsSetting = process.env.GALLERY_WIDTHS;
  if (widthsSetting === undefined) {
    if (process.env.GALLERY_THEMES !== undefined || process.env.GALLERY_START_HERE !== undefined) {
      console.error("GALLERY_THEMES and GALLERY_START_HERE need GALLERY_WIDTHS");
      process.exit(2);
    }
    await runDefault();
    return;
  }

  if (!process.env.GALLERY_OUT && !dryRun) {
    console.error("GALLERY_WIDTHS needs GALLERY_OUT, so the default run's index stays intact");
    process.exit(2);
  }

  const themesSetting = process.env.GALLERY_THEMES;
  await runAtSizes({
    sizes: parseSizes(widthsSetting),
    themes: themesSetting === undefined ? THEMES : parseThemes(themesSetting),
    startHere: process.env.GALLERY_START_HERE === "1",
  });
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
