/**
 * H3-T1, RG-T1, RG-T2 — live proof that a session already in flight is re-evaluated against the
 * DATABASE on every request, not against the JWT it was minted with.
 *
 * The session strategy is permanently JWT (a Credentials provider forbids database sessions in
 * Auth.js — see the restated auth-D3), and the cookie lives for a year. Everything that makes an
 * admin demotion or a suspension take effect NOW rather than in twelve months is
 * `loadLiveAccountState` reading `users.role` and `users.suspended_at` on each request. The unit
 * tests cover that function and the guard above it separately; nothing had ever held a real cookie,
 * changed the row underneath it, and asked the running app what happens next.
 *
 * WHY A BROWSER AND NOT `fetch`. Two reasons, both learned the hard way while writing this:
 *
 *   1. A `redirect()` from a Server Component does NOT reliably surface as a 307 to a raw fetch —
 *      Next answers 200 and resolves the navigation from the payload. Asserting on the status code
 *      reports a passing guard as a failure (and, worse, would report a REMOVED guard as a pass,
 *      since a rendered page is also 200). The honest assertion is where the browser ends up and
 *      what actually rendered.
 *   2. Participant nav visibility is decided CLIENT-side from `session.user.role` (RG-D4), so it is
 *      simply absent from server HTML. A fetch-based check of the markup measures nothing.
 *
 * Usage: node --import tsx scripts/session/live-session-gates.ts
 * Requires: the dev server on BASE (npm run dev), local Postgres, and the seeded users.
 * Exit code: 0 when every assertion holds; 1 otherwise.
 *
 * Every mutated row is restored in a finally block, and the script re-asserts the restore landed —
 * a seed left demoted or suspended would silently break every later run of the other suites.
 */

import { createChecker, finish, openPool } from "../lib/live-harness";

const main = async (): Promise<void> => {
  const { client } = await openPool();
  const { launch, contextFor } = await import("../testing/lib-browser.mjs");
  const { USERS, BASE } = await import("../testing/seeds.mjs");

  const { check, failureCount } = createChecker();
  const restores: Array<() => Promise<void>> = [];
  const browser = await launch();

  // Where a navigation ACTUALLY ended up, plus whether the guarded content rendered. Both matter:
  // a guard that redirects to the right place but still streams the page has leaked it.
  const land = async (
    context: import("playwright").BrowserContext,
    path: string,
  ): Promise<{ url: string; heading: string }> => {
    const page = await context.newPage();
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    // A guard redirect resolves after hydration, so the first paint is not the final answer.
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const url = page.url().replace(BASE, "");
    const heading = await page
      .locator("h1")
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    await page.close();
    return { url, heading: (heading ?? "").trim() };
  };

  try {
    const opsContext = await contextFor(browser, USERS.ops.email);
    const candContext = await contextFor(browser, USERS.candA.email);

    // ---- H3-T1: role demotion lands on the next request ---------------------------------------

    console.log(`\n[H3-T1] an admin demoted out of band loses access on the very next navigation`);

    const adminBefore = await land(opsContext, "/admin/institutions");
    check(
      adminBefore.url.startsWith("/admin/institutions"),
      `H3-01  platform_ops reaches /admin/institutions (landed on ${adminBefore.url})`,
    );

    restores.push(async () => {
      await client`UPDATE users SET role = 'platform_ops' WHERE id = ${USERS.ops.id}`;
    });
    await client`UPDATE users SET role = 'candidate' WHERE id = ${USERS.ops.id}`;

    const adminAfter = await land(opsContext, "/admin/institutions");
    check(
      !adminAfter.url.startsWith("/admin"),
      `H3-02  the SAME cookie is refused after a SQL demotion — the JWT still says platform_ops (landed on ${adminAfter.url})`,
    );

    await client`UPDATE users SET role = 'platform_ops' WHERE id = ${USERS.ops.id}`;
    const adminRestored = await land(opsContext, "/admin/institutions");
    check(
      adminRestored.url.startsWith("/admin/institutions"),
      `H3-03  re-promoting restores access on the next navigation, same cookie throughout (landed on ${adminRestored.url})`,
    );

    // ---- RG-T2: page-level suspension gate ----------------------------------------------------

    console.log(`\n[RG-T2] suspending an account mid-session stops the next page render`);

    const dashBefore = await land(candContext, "/candidate-dashboard");
    check(
      dashBefore.heading === "Dasbor kandidat",
      `RG2-01  candidate sees the dashboard (heading "${dashBefore.heading}")`,
    );

    restores.push(async () => {
      await client`UPDATE users SET suspended_at = NULL, suspension_reason = NULL WHERE id = ${USERS.candA.id}`;
    });
    await client`
      UPDATE users SET suspended_at = now(), suspension_reason = 'live gate probe'
      WHERE id = ${USERS.candA.id}
    `;

    const dashSuspended = await land(candContext, "/candidate-dashboard");
    check(
      dashSuspended.url.startsWith("/suspended"),
      `RG2-02  a mid-session suspension routes the next PAGE render to /suspended, not just the API (landed on ${dashSuspended.url})`,
    );
    check(
      dashSuspended.heading !== "Dasbor kandidat",
      "RG2-03  the dashboard did not render on the way out — the guard runs before the content",
    );

    await client`UPDATE users SET suspended_at = NULL, suspension_reason = NULL WHERE id = ${USERS.candA.id}`;
    const dashRestored = await land(candContext, "/candidate-dashboard");
    check(
      dashRestored.heading === "Dasbor kandidat",
      `RG2-04  lifting the suspension restores the page on the next navigation (heading "${dashRestored.heading}")`,
    );

    // ---- RG-T1: operational accounts are refused participant surfaces, and not offered them ----

    console.log(`\n[RG-T1] an operational account is refused a participant page AND not offered it`);

    const opsDash = await land(opsContext, "/candidate-dashboard");
    check(
      opsDash.url.startsWith("/admin"),
      `RG1-01  platform_ops is sent from /candidate-dashboard to its own workspace (landed on ${opsDash.url})`,
    );
    check(
      opsDash.heading !== "Dasbor kandidat",
      "RG1-02  the participant dashboard never rendered for the operational account",
    );

    // The redirect alone is only half of it: an account offered a link that always bounces has a
    // broken app. Visibility is decided client-side from `session.user.role` (RG-D4), so this has
    // to be read after hydration — it is simply absent from server HTML.
    //
    // Counted per region. The two once disagreed — the header withheld the link and the footer did
    // not (RG-D8) — and keeping them separate is what surfaced that. The footer no longer carries
    // navigation at all, so its count is now asserted at zero alongside the header's.
    const linkCounts = async (
      context: import("playwright").BrowserContext,
    ): Promise<{ header: number; footer: number }> => {
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      const selector = 'a[href="/candidate-dashboard"]';
      const header = await page.locator(`header ${selector}`).count();
      const footer = await page.locator(`footer ${selector}`).count();
      await page.close();
      return { header, footer };
    };

    const opsLinks = await linkCounts(opsContext);
    const candLinks = await linkCounts(candContext);

    check(
      opsLinks.header === 0 && opsLinks.footer === 0,
      `RG1-03  participant navigation is withheld from an operational account in BOTH regions (header ${opsLinks.header}, footer ${opsLinks.footer})`,
    );
    check(
      candLinks.header > 0,
      `RG1-04  control: the header DOES offer it to a candidate, so RG1-03 is not a false pass (found ${candLinks.header})`,
    );
    // The footer carries no navigation for anyone now, so a candidate sees zero there too. Asserted
    // rather than assumed: a footer link would reach operational accounts as well, which is exactly
    // how RG-D8 happened.
    check(
      candLinks.footer === 0,
      `RG1-05  the footer carries no participant navigation for any account (candidate found ${candLinks.footer})`,
    );
  } finally {
    for (const restore of restores) {
      await restore().catch((error) => {
        console.error(`RESTORE FAILED — fix by hand before trusting later runs: ${String(error)}`);
      });
    }
    await browser.close();
  }

  // The restores above run even on a thrown assertion, so confirm the seed is genuinely back rather
  // than trusting that they did. A seed left demoted or suspended breaks every later suite quietly.
  const opsRow = await client<{ role: string }[]>`SELECT role FROM users WHERE id = ${USERS.ops.id}`;
  const candRow = await client<{ suspended_at: Date | null }[]>`
    SELECT suspended_at FROM users WHERE id = ${USERS.candA.id}
  `;
  console.log(`\n[seed restored]`);
  check(opsRow[0]?.role === "platform_ops", `SEED-01  ops account is platform_ops again (got ${opsRow[0]?.role})`);
  check(
    candRow[0]?.suspended_at === null,
    `SEED-02  candA is not suspended (got ${String(candRow[0]?.suspended_at)})`,
  );

  await client.end({ timeout: 5 });
  finish(failureCount(), "LIVE SESSION GATE");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
