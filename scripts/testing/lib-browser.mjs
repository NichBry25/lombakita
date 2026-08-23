import { existsSync } from "fs";
import { chromium } from "playwright";
import { elevateMfaSession, mintSession } from "./lib-auth.mjs";
import { BASE, USERS } from "./seeds.mjs";

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

// Playwright 1.62 refuses to install Chromium on mac13-arm64, but a compatible build is already
// in the shared ms-playwright cache; point at it directly rather than downgrading the library.
// Anywhere that path does not exist — CI on Linux, a different machine — leave executablePath
// undefined so Playwright resolves the browser it installed itself. Pinning the mac path
// unconditionally is what would make these scripts unrunnable off this laptop.
const MAC_CACHED_CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CHROME =
  process.env.CHROME_PATH ?? (existsSync(MAC_CACHED_CHROME) ? MAC_CACHED_CHROME : undefined);

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
    // Signing in is not enough for an operational account: a fresh JWT carries no MFA claim, so
    // every guarded surface would redirect to /auth/mfa/challenge. Complete the challenge here for
    // the accounts seeded as "satisfied", and leave the other two in the gate on purpose — those
    // are the fixtures for the enrolment and challenge pages themselves.
    if (Object.values(USERS).find((u) => u.email === email)?.mfa === "satisfied") {
      await elevateMfaSession(s.jar);
    }
    const cookies = [...s.jar.entries()].map(([name, value]) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    }));
    await context.addCookies(cookies);
  }
  // Pin the stored theme so the header's mount effect never fights an explicit override.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("lombakita-theme", "light");
    } catch {
      /* ignore */
    }
  });
  return context;
}

export async function setTheme(page, theme) {
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    try {
      window.localStorage.setItem("lombakita-theme", t);
    } catch {
      /* ignore */
    }
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
/**
 * Waits until the page has actually finished rendering itself, rather than for a fixed number of
 * milliseconds.
 *
 * THE FIXED SLEEP WAS A SILENT FALSE NEGATIVE. Both audits used `domcontentloaded` plus ~1.5s, and
 * client sections that fetch their own data render after that on a cold dev server. A control that
 * had not appeared yet was measured as absent and the page was reported CLEAN. The same page
 * returned clean, then dirty, then dirty across three consecutive runs with no code change.
 *
 * A contrast or target-size audit that reports success for a control it never saw is worse than no
 * audit, because the number it produces gets quoted.
 *
 * Two conditions, both bounded so a genuinely broken page still gets measured rather than hanging:
 * the network goes quiet, and nothing is still declaring itself busy.
 */
export async function settle(page, { budgetMs = 8000 } = {}) {
  await page.waitForLoadState("networkidle", { timeout: budgetMs }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[aria-busy="true"], .skeleton, [data-skeleton]').length === 0,
      undefined,
      { timeout: budgetMs },
    )
    .catch(() => {});
}

export async function visit(page, path, { waitMs = 700 } = {}) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  return { status: res?.status() ?? 0, url: page.url() };
}

export async function shot(page, file) {
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
}

/**
 * Opens every collapsed section on the page so the audits can measure what is inside it.
 *
 * A collapsed section is not hidden — it is ABSENT. The batch document-request form renders as
 * `{expanded ? <form/> : null}`, so its rows are not in the DOM at all when an audit arrives, and
 * every control and every text pairing inside it was reported as measured-and-clean when it had
 * never been looked at. That is the same defect class as a fixed sleep: a number produced about
 * something the tool never saw.
 *
 * Only `<details>` and buttons that declare `aria-expanded="false"` are touched. A link or a submit
 * button would navigate, which would end the measurement rather than widen it.
 */
export async function expandCollapsibles(page) {
  const opened = await page
    .evaluate(() => {
      let count = 0;
      for (const details of document.querySelectorAll("details:not([open])")) {
        details.open = true;
        count += 1;
      }
      for (const control of document.querySelectorAll('button[aria-expanded="false"]')) {
        if (control.type === "submit" || control.disabled) continue;
        control.click();
        count += 1;
      }
      return count;
    })
    .catch(() => 0);
  if (opened > 0) await settle(page);
  return opened;
}
