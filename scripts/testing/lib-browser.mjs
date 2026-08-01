import { chromium } from "playwright";
import { mintSession } from "./lib-auth.mjs";
import { BASE } from "./seeds.mjs";

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

// Playwright 1.62 refuses to install Chromium on mac13-arm64, but a compatible build is already
// in the shared ms-playwright cache; point at it directly rather than downgrading the library.
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

export async function launch() {
  return chromium.launch({ executablePath: CHROME, args: ["--disable-dev-shm-usage"] });
}

/** Browser context carrying a real session for `email` (null = signed out). */
export async function contextFor(browser, email) {
  const context = await browser.newContext({ viewport: DESKTOP, locale: "id-ID" });
  // Turbopack reuses a chunk's FILENAME while changing its contents, so a cached copy of
  // `[root-of-the-server]__<hash>._.css` silently serves pre-edit styles — every screenshot and
  // measurement then describes an app that no longer exists. Force revalidation.
  await context.setExtraHTTPHeaders({ "Cache-Control": "no-cache", Pragma: "no-cache" });
  if (email) {
    const s = await mintSession(email);
    if (!s.ok) throw new Error(`session mint failed for ${email}: ${s.error}`);
    const cookies = [...s.jar.entries()].map(([name, value]) => ({
      name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
    }));
    await context.addCookies(cookies);
  }
  // Pin the stored theme so the header's mount effect never fights an explicit override.
  await context.addInitScript(() => {
    try { window.localStorage.setItem("lombakita-theme", "light"); } catch { /* ignore */ }
  });
  return context;
}

export async function setTheme(page, theme) {
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    try { window.localStorage.setItem("lombakita-theme", t); } catch { /* ignore */ }
  };
  // A client-side redirect can destroy the execution context mid-evaluate; settle and retry once.
  try {
    await page.evaluate(apply, theme);
  } catch {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.evaluate(apply, theme).catch(() => {});
  }
  await page.waitForTimeout(180);
}

/** Navigate and let the page settle; returns the final URL and HTTP status. */
export async function visit(page, path, { waitMs = 700 } = {}) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  return { status: res?.status() ?? 0, url: page.url() };
}

export async function shot(page, file) {
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
}
