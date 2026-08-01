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
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { launch, contextFor, setTheme, visit, shot, DESKTOP, MOBILE } from "./lib-browser.mjs";
import { PAGES } from "./pages.mjs";
import { USERS } from "./seeds.mjs";

const REPO = "/Users/nikau/Desktop/lombakita";
const OUT = `${REPO}/test-artifacts/gallery`;
const STATE = `${OUT}/gallery.json`;
const MODES = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];
const RECYCLE = 12;
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const force = process.env.FORCE === "1";

const loadState = () => {
  try { return new Map(JSON.parse(readFileSync(STATE, "utf8")).map((r) => [r.id, r])); }
  catch { return new Map(); }
};

const capturePage = async (browser, contexts, p) => {
  const key = p.as ?? "anon";
  if (!contexts.has(key)) contexts.set(key, await contextFor(browser, p.as ? USERS[p.as].email : null));
  const context = contexts.get(key);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

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

    const base = p.path.split("?")[0];
    const redirected = Boolean(r.url) && !r.url.includes(base);
    return { ...p, status: r.status, finalUrl: r.url, redirected, consoleErrors: [...new Set(consoleErrors)], error: null };
  } finally {
    await page.close().catch(() => {});
  }
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const state = loadState();
  const targets = PAGES.filter((p) => !only || only.test(p.id) || only.test(p.path));

  let browser = await launch();
  let contexts = new Map();
  let sinceRecycle = 0;

  for (const p of targets) {
    const done = MODES.every((m) => existsSync(`${OUT}/${p.id}/${m}.png`));
    if (done && !force && state.has(p.id) && !state.get(p.id).error) {
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
        row = await capturePage(browser, contexts, p);
      } catch (e) {
        const msg = String(e).slice(0, 200);
        if (attempt === 2) {
          row = { ...p, status: 0, finalUrl: "", redirected: false, consoleErrors: [], error: msg };
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
    console.log(`${row.error ? "ERR " : "ok  "} ${p.id.padEnd(34)} ${String(row.status).padEnd(4)} ${row.redirected ? "→ " + row.finalUrl.replace("http://localhost:3000", "") : ""}${row.consoleErrors.length ? "  [console:" + row.consoleErrors.length + "]" : ""}${row.error ? "  " + row.error : ""}`);
  }

  await browser.close().catch(() => {});

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
      const shots = MODES.map((m) => `[${m.replace("desktop-", "D-").replace("mobile-", "M-")}](${r.id}/${m}.png)`).join(" · ");
      const notes = [
        r.redirected ? `redirected → \`${r.finalUrl.replace("http://localhost:3000", "")}\`` : "",
        r.consoleErrors.length ? `${r.consoleErrors.length} console error(s)` : "",
        r.error ? `CAPTURE ERROR: ${r.error}` : "",
      ].filter(Boolean).join("; ");
      return `| ${r.id} | ${r.label}<br/>\`${r.path}\` | ${r.as ?? "signed out"} | ${r.status} | ${shots} | ${notes} |`;
    }),
    "",
    "## Console errors seen during capture",
    "",
    ...rows.filter((r) => r.consoleErrors.length).flatMap((r) => [`**${r.id}** \`${r.path}\``, ...r.consoleErrors.map((e) => `- \`${e.replaceAll("|", "/")}\``), ""]),
  ].join("\n");
  writeFileSync(`${OUT}/index.md`, md);
  console.log(`\nGallery: ${rows.length} pages recorded → test-artifacts/gallery/index.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
