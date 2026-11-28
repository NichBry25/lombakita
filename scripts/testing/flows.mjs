/**
 * UI behavior flows: real clicks and typing, with a screenshot of every reaction so the owner
 * can judge how each state LOOKS without redoing the action.
 * Writes test-artifacts/behavior/flows/<flow>/NN-<step>.png + flows.md
 */
import { mkdirSync, writeFileSync } from "fs";
import { launch, contextFor, visit, shot, DESKTOP } from "./lib-browser.mjs";
import { USERS, BASE, PASSWORD } from "./seeds.mjs";

const REPO = "/Users/nikau/Developer/lombakita";
const OUT = `${REPO}/test-artifacts/behavior/flows`;
const steps = [];

const runFlow = async (browser, name, as, fn) => {
  const dir = `${OUT}/${name}`;
  mkdirSync(dir, { recursive: true });
  const context = await contextFor(browser, as ? USERS[as].email : null);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP);
  let n = 0;
  const capture = async (stepName, note = "") => {
    n += 1;
    const file = `${String(n).padStart(2, "0")}-${stepName}`;
    await page.waitForTimeout(500);
    await shot(page, `${dir}/${file}.png`);
    steps.push({
      flow: name,
      step: stepName,
      file: `${name}/${file}.png`,
      note,
      url: page.url().replace(BASE, ""),
    });
    console.log(`  shot ${name}/${file}  ${note}`);
  };
  try {
    await fn(page, capture);
    console.log(`ok   flow ${name}`);
  } catch (e) {
    console.log(`ERR  flow ${name}: ${String(e).slice(0, 200)}`);
    steps.push({
      flow: name,
      step: "ERROR",
      file: "",
      note: String(e).slice(0, 250),
      url: page.url().replace(BASE, ""),
    });
    await shot(page, `${dir}/99-error-state.png`).catch(() => {});
  }
  await context.close();
};

const clickText = async (page, text, opts = {}) => {
  const el = page.getByRole("button", { name: text, exact: false }).first();
  await el.click({ timeout: 10000, ...opts });
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();

  // ---------------------------------------------------------------- login flows
  await runFlow(browser, "login-suspended", null, async (page, capture) => {
    await visit(page, "/auth/login");
    await capture("entry", "method-first auth entry");
    await page
      .getByRole("button", { name: /email & password/i })
      .first()
      .click();
    await page.waitForSelector("#auth-email", { timeout: 20000 });
    await capture("credentials-form", "email + password stage");
    await page.fill("#auth-email", USERS.susp.email);
    await page.fill("#auth-password", PASSWORD);
    await clickText(page, "Lanjut");
    await page.waitForURL(/suspended/, { timeout: 20000 }).catch(() => {});
    await capture("suspended-page", "suspended account is routed to /suspended, no session");
  });

  await runFlow(browser, "login-unverified", null, async (page, capture) => {
    await visit(page, "/auth/login");
    await page
      .getByRole("button", { name: /email & password/i })
      .first()
      .click();
    await page.waitForSelector("#auth-email", { timeout: 20000 });
    await page.fill("#auth-email", USERS.unver.email);
    await clickText(page, "Lanjut");
    await capture("unverified-notice", "unverified email → resend offered, signup NOT offered");
  });

  await runFlow(browser, "login-new-email", null, async (page, capture) => {
    await visit(page, "/auth/login");
    await page
      .getByRole("button", { name: /email & password/i })
      .first()
      .click();
    await page.waitForSelector("#auth-email", { timeout: 20000 });
    await page.fill("#auth-email", "calon.baru@seed.lombakita.local");
    await page.fill("#auth-password", PASSWORD);
    await clickText(page, "Lanjut");
    await capture(
      "signup-form",
      "unknown email → sign-up form with no role question (signup branch)",
    );
  });

  await runFlow(browser, "login-wrong-password", null, async (page, capture) => {
    await visit(page, "/auth/login");
    await page
      .getByRole("button", { name: /email & password/i })
      .first()
      .click();
    await page.waitForSelector("#auth-email", { timeout: 20000 });
    await page.fill("#auth-email", USERS.candA.email);
    await page.fill("#auth-password", "SalahSekali999!");
    await clickText(page, "Lanjut");
    await capture("invalid-credentials", "wrong password error surface");
  });

  // ---------------------------------------------------------------- candidate flows
  await runFlow(browser, "save-toggle", "candA", async (page, capture) => {
    await visit(page, "/competitions/seed-academy/seed-closing");
    await capture("detail-before", "detail page, competition not yet saved");
    await page
      .getByRole("button", { name: /simpan kompetisi/i })
      .first()
      .click();
    await capture("after-save", "save control reacts (bookmark filled / label flips)");
    await page
      .getByRole("button", { name: /hapus dari tersimpan/i })
      .first()
      .click();
    await capture("after-unsave", "unsaved again");
  });

  await runFlow(browser, "register-individual", "candB", async (page, capture) => {
    await visit(page, "/competitions/seed-academy/seed-featured");
    await capture("detail-cta", "CTA state for an open individual competition");
    await visit(page, "/competitions/seed-academy/seed-featured/registration");
    await capture("registration-page", "registration subpage — individual only");
    const btn = page.getByRole("button", { name: /daftar/i }).first();
    if (await btn.count()) {
      await btn.click();
      await capture("after-register", "reaction after submitting an individual registration");
    }
    await visit(page, "/candidate-dashboard");
    await capture("dashboard-after", "new registration visible on the dashboard");
  });

  await runFlow(browser, "register-closed-refused", "candB", async (page, capture) => {
    await visit(page, "/competitions/seed-academy/seed-closed");
    await capture("detail-closed", "CTA disabled — registration closed");
    await visit(page, "/competitions/seed-academy/seed-closed/registration");
    await capture("registration-closed", "registration subpage refuses a closed competition");
  });

  await runFlow(browser, "cancel-registration", "candA", async (page, capture) => {
    await visit(page, "/candidate-dashboard");
    await capture("dashboard", "candidate dashboard with registrations");
    await visit(page, "/candidate-dashboard/registrations/seed-reg-a-open");
    await capture(
      "registration-detail",
      "registration detail for a cancellable competition (allow_cancellation=true, cutoff 3d)",
    );
    const cancel = page.getByRole("button", { name: /batalkan/i }).first();
    if (await cancel.count()) {
      await cancel.click();
      await capture("cancel-modal", "cancellation confirmation modal (reason required)");
    }
  });

  await runFlow(browser, "document-request-respond", "candA", async (page, capture) => {
    await visit(page, "/candidate-dashboard/registrations/seed-reg-a-inprog");
    await capture("open-request", "candidate side of an OPEN document request with a deadline");
  });

  await runFlow(browser, "inbox-read", "candA", async (page, capture) => {
    await visit(page, "/inbox");
    await capture("inbox-before", "inbox with unread notifications and a pending team invite");
    const markRead = page.getByRole("button", { name: /tandai|baca/i }).first();
    if (await markRead.count()) {
      await markRead.click();
      await capture("after-mark-read", "reaction after marking a notification read");
    }
  });

  await runFlow(browser, "team-invite-accept", "candA", async (page, capture) => {
    await visit(page, "/inbox");
    const accept = page.getByRole("button", { name: /terima/i }).first();
    if (await accept.count()) {
      await accept.click();
      await capture("after-accept-invite", "accepting the team invitation from the inbox");
      await visit(page, "/competitions/seed-academy/seed-upcoming/registration");
      await capture("team-roster", "team roster after joining");
    } else {
      await capture("no-accept-control", "no accept control found on the inbox invite card");
    }
  });

  // ---------------------------------------------------------------- recruiter flows
  // seed-rvs-min waits on this draft, so the control reads Sedang diperiksa and offers no press. A
  // draft with no open check offers Kirim untuk diperiksa, and a trusted account Terbitkan.
  await runFlow(browser, "host-check-press", "recMin", async (page, capture) => {
    await visit(page, "/recruiter-dashboard");
    await capture(
      "dashboard-pending",
      "host dashboard: Status penyelenggara names the draft waiting for its host check",
    );
    await visit(page, "/institution/seed-rec-min/competitions/seed-personal-draft");
    await capture("draft-detail", "the draft its host check names, with the control it offers");
    const sendForCheck = page.getByRole("button", { name: "Kirim untuk diperiksa", exact: true });
    const publish = page.getByRole("button", { name: "Terbitkan", exact: true });
    const press = (await sendForCheck.count()) > 0 ? sendForCheck.first() : publish.first();
    if (await press.count()) {
      await press.click();
      await page.waitForTimeout(800);
      await capture(
        "after-press",
        "reaction to the press: a host check opens, or the account publishes",
      );
    } else {
      await capture("press-withheld", "no press offered: this draft's host check is waiting");
    }
  });

  await runFlow(browser, "publish-success-elevated", "recElev", async (page, capture) => {
    await visit(page, "/institution/seed-ventures/competitions/seed-b-draft");
    await capture("draft-detail", "complete draft under Seed Ventures");
    const publish = page.getByRole("button", { name: /^terbitkan$/i }).first();
    if (await publish.count()) {
      await publish.click();
      await page.waitForTimeout(1200);
      await capture("after-publish", "reaction after a successful publish (Trusted recruiter)");
      const unpublish = page
        .getByRole("button", { name: /tarik ke draf|batalkan publikasi/i })
        .first();
      if (await unpublish.count()) {
        await unpublish.click();
        await capture("unpublish-modal", "unpublish confirmation (cancels registrations)");
      }
    }
  });

  await runFlow(browser, "post-publish-edit-guard", "recElev", async (page, capture) => {
    await visit(page, "/institution/seed-academy/competitions/seed-open/edit?langkah=2");
    await capture("edit-published", "editing a published competition — immutable fields disabled");
  });

  await runFlow(browser, "participants-review", "recElev", async (page, capture) => {
    await visit(page, "/institution/seed-academy/competitions/seed-done/participants");
    await capture("participants", "participants console for a finished competition");
    await visit(
      page,
      "/institution/seed-academy/competitions/seed-done/participants/seed-reg-a-done",
    );
    await capture("review-page", "review page: submission, internal status, result, documents");
  });

  await runFlow(browser, "document-request-create", "recElev", async (page, capture) => {
    await visit(page, "/institution/seed-academy/competitions/seed-open/participants");
    await capture("participants-open", "participants console with document-request controls");
  });

  await runFlow(browser, "institution-verification-lock", "recElev", async (page, capture) => {
    await visit(page, "/institution/seed-academy/verification");
    await capture("verified-panel", "verified institution: status panel instead of the form");
    await visit(page, "/institution/seed-ventures/verification");
    await capture("pending-panel", "pending submission: form locked behind a status panel");
  });

  // Dodi owns no workspace, so on a fresh seed the press creates one and lands on its board. A later
  // run before a reseed creates another, until the cap of 3 refuses the press on the create form.
  await runFlow(browser, "personal-create", "recDraft", async (page, capture) => {
    await visit(page, "/institution/create");
    await capture("create-form", "the one create form, with the kind select empty");
    await page.fill("#institution-display-name", "Lomba Budi");
    await page.click("#institution-type");
    await page.getByRole("option", { name: "Pribadi", exact: true }).click();
    await capture("kind-picked", "Pribadi picked as the kind of the new workspace");
    await page
      .locator(".form-action-bar-end")
      .getByRole("button", { name: "Buat institusi", exact: true })
      .click();
    await page
      .waitForURL((url) => !url.pathname.endsWith("create"), { timeout: 20000 })
      .catch(() => {});
    await capture("board", "the board of the new personal workspace, or the refusal of the press");
  });

  // ---------------------------------------------------------------- ops flows
  await runFlow(browser, "ops-host-checks", "ops", async (page, capture) => {
    await visit(page, "/admin/host-checks");
    await capture("queue", "staff host check queue: host name, phone, email and the draft");
    const turnDown = page.getByRole("button", { name: "Tolak", exact: true }).first();
    if (await turnDown.count()) {
      await turnDown.click();
      await capture(
        "turn-down-dialog",
        "turn-down dialog: Pedoman yang tidak dipenuhi and a required Catatan untuk penyelenggara",
      );
    }
    await visit(page, "/admin/host-checks");
    await page.getByRole("tab", { name: "Centang", exact: true }).click();
    await page.waitForTimeout(1200);
    await capture("centang-tab", "Centang tab: tick requests, name checks and running proofs");
  });

  await runFlow(browser, "ops-moderation", "ops", async (page, capture) => {
    await visit(page, "/admin/moderation");
    await capture("console", "moderation console");
    const input = page
      .locator('input[type="email"], input[name*="email" i], input[type="search"]')
      .first();
    if (await input.count()) {
      await input.fill(USERS.candC.email);
      await capture("lookup-typed", "user lookup query entered");
      const search = page.getByRole("button", { name: /cari|lookup/i }).first();
      if (await search.count()) {
        await search.click();
        await page.waitForTimeout(1200);
        await capture("lookup-result", "user lookup result with suspend / note controls");
        const suspend = page.getByRole("button", { name: /tangguhkan|suspend/i }).first();
        if (await suspend.count()) {
          await suspend.click();
          await capture("suspend-modal", "suspension confirmation modal (reason required)");
        }
      }
    }
  });

  await runFlow(browser, "ops-featured", "ops", async (page, capture) => {
    await visit(page, "/admin/featured");
    await capture("featured", "featured placement controls");
  });

  await runFlow(browser, "ops-institutions", "ops", async (page, capture) => {
    await visit(page, "/admin/institutions");
    await capture("table", "institution verification table with transition controls");
    const revoke = page.getByRole("button", { name: /cabut verifikasi/i }).first();
    if (await revoke.count()) {
      await revoke.click();
      await capture("revoke-modal", "revocation modal — states that it is not a takedown");
    }
  });

  // ---------------------------------------------------------------- guards
  await runFlow(browser, "guard-ops-on-candidate", "ops", async (page, capture) => {
    const r = await visit(page, "/candidate-dashboard");
    await capture(
      "redirected",
      `operational account on a participant surface → ${r.url.replace(BASE, "")}`,
    );
  });

  await runFlow(browser, "guard-candidate-on-institution", "candA", async (page, capture) => {
    const r = await visit(page, "/institution/seed-academy/settings");
    await capture("redirected", `candidate on an institution surface → ${r.url.replace(BASE, "")}`);
  });

  await runFlow(browser, "guard-cross-tenant", "recMin", async (page, capture) => {
    const r = await visit(page, "/institution/seed-academy/competitions/seed-open/participants");
    await capture(
      "blocked",
      `outsider recruiter on another institution → ${r.url.replace(BASE, "")}`,
    );
  });

  await browser.close();

  writeFileSync(`${OUT}/flows.json`, JSON.stringify(steps, null, 2));
  const byFlow = new Map();
  for (const s of steps) {
    if (!byFlow.has(s.flow)) byFlow.set(s.flow, []);
    byFlow.get(s.flow).push(s);
  }
  const md = [
    "# Behavior Flows — UI reactions to automated actions",
    `Captured ${new Date().toISOString()}. Every screenshot is the app's reaction to an action`,
    "the pipeline performed for you, so you can judge how the state looks without redoing it.",
    "",
    ...[...byFlow.entries()].flatMap(([flow, list]) => [
      `## ${flow}`,
      "",
      "| Step | Screenshot | URL | What it shows |",
      "|---|---|---|---|",
      ...list.map(
        (s) =>
          `| ${s.step} | ${s.file ? `[png](${s.file})` : "—"} | \`${s.url}\` | ${s.note.replaceAll("|", "/")} |`,
      ),
      "",
    ]),
  ].join("\n");
  writeFileSync(`${OUT}/flows.md`, md);
  console.log(
    `\n${steps.length} reaction screenshots across ${byFlow.size} flows → test-artifacts/behavior/flows/flows.md`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
