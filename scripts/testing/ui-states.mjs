/*
 * DOM state assertions: what each surface must SAY, and what it must NOT OFFER.
 *
 * This exists because nothing else in the pipeline could answer that question. `contrast-audit`
 * measures colour, `mobile-audit` measures overflow, and both report a page that rendered NOTHING
 * as perfectly clean. `flows` and `gallery` take screenshots and never fail. So a panel that
 * silently stopped rendering, or a control that was supposed to be WITHHELD and came back, would
 * pass every automated check the repo had.
 *
 * Two kinds of assertion, and the second is the reason this file is worth its weight:
 *
 *   present  — the surface renders this text. Catches a panel that vanished.
 *   absent   — the surface does NOT render this control. Catches a withheld affordance that came
 *              back, which is the failure that cannot be seen in a screenshot of the state where
 *              it is CORRECTLY absent.
 *
 * An `absent` assertion is only meaningful next to a `present` one on another case: "candB has no
 * upload button" passes trivially on a blank page. Every absent case here is paired.
 *
 * Usage:  node scripts/testing/ui-states.mjs [idFilterRegex]
 * Exits non-zero on any miss, so it can gate a change the way the other audits do.
 */
import { launch, contextFor, DESKTOP } from "./lib-browser.mjs";
import { BASE, COMP, INST, USERS } from "./seeds.mjs";

/**
 * @typedef {object} UiStateCase
 * @property {string} id       stable identifier, also the filter key
 * @property {string} as       key into USERS
 * @property {string} path     path under BASE
 * @property {string[]} present  text that MUST appear in <main>
 * @property {string[]} absent   text that must NOT appear in <main>
 * @property {string} why      one line: what breaking this would mean
 */

/** @type {UiStateCase[]} */
export const CASES = [
  {
    id: "payment-awaiting-transfer",
    as: "candA",
    path: "/candidate-dashboard/registrations/seed-reg-a-paid",
    present: [
      "Pembayaran",
      "Rp 150.000",
      "1370012345678",
      "Yayasan Seed Academy",
      "Kirim bukti transfer",
      "BATAS WAKTU",
    ],
    // The deadline is LIVE here, so the suspension sentence must not appear. Its countdown text is
    // time-dependent and is asserted in payment-deadline.test.ts rather than pinned to a seed date.
    absent: ["Tidak berlaku selama bukti transfer Anda ditinjau"],
    why: "the payer must be told the amount and the account, and offered the upload",
  },
  {
    id: "payment-awaiting-review",
    as: "candB",
    path: "/candidate-dashboard/registrations/seed-reg-b-paid",
    present: [
      "Menunggu verifikasi",
      "sedang ditinjau penyelenggara",
      // R5 ON THE PAGE. Evidence is with the organiser, so the deadline cannot end this
      // registration — and the candidate must be able to see that, not infer it.
      "Tidak berlaku selama bukti transfer Anda ditinjau",
    ],
    // THE WITHHELD AFFORDANCE. Paired with the case above, which proves the control renders when it
    // should — without that pairing this assertion would pass on an empty page.
    absent: ["Kirim bukti transfer"],
    why: "evidence is with the organiser; offering another upload invites a duplicate that the server refuses",
  },
  {
    id: "payment-rejected-resubmittable",
    as: "candC",
    path: "/candidate-dashboard/registrations/seed-reg-c-paid",
    present: [
      "Perlu bukti baru",
      "Nominal transfer tidak sesuai",
      "Unggah bukti transfer baru",
      "BATAS WAKTU",
    ],
    // RESUMED. A rejection puts the candidate back on a running clock, so the suspension sentence
    // must be gone — this is the half of the pairing that catches a suspension that never lifts.
    absent: ["Tidak berlaku selama bukti transfer Anda ditinjau"],
    absent: [],
    why: "the organiser's reason is the instruction the candidate works from, so it must be page content that survives a reload",
  },

  // ── Surface 2: the organiser's verdict queue ──────────────────────────────────────────────────
  {
    id: "organiser-queue-own-competition",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.paid.slug}/payments`,
    present: [
      "Verifikasi pembayaran",
      "Verifikasi",
      "Tolak",
      "Lihat bukti",
      // DEC-0130 in the reviewer's own words. Verification asserts money arrived in the
      // institution's account, which only their bank statement can establish.
      "rekening lembaga Anda",
    ],
    absent: [],
    why: "the reviewer must be able to act, and must be told the platform is not holding this money",
  },
  {
    id: "organiser-queue-shows-every-verdict-state",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.paid.slug}/payments`,
    // All three settled/unsettled states on one page, which is also the only place the `paid` badge
    // tone renders — the gap that let a wrong tone value ship unnoticed through a full audit pass.
    present: ["Perlu ditinjau", "Diverifikasi", "Ditolak", "Dewi Anggraini"],
    // Nothing to assert as absent on a MIXED queue: a settled proof and a pending one share the
    // page, so "Verifikasi" is legitimately present for the pending row. The withholding is proven
    // instead in `src/components/finance/organiser-payment-queue.test.tsx`, which renders a queue
    // of settled proofs only — a state no seeded competition is in.
    absent: [],
    why: "the reviewer must be able to tell the three verdict states apart at a glance",
  },
  {
    id: "organiser-entry-point-on-paid-competition",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.paid.slug}/participants`,
    present: ["Verifikasi pembayaran"],
    absent: [],
    why: "the queue is only reachable from here, so a missing link makes the whole surface unreachable",
  },
  {
    id: "organiser-entry-point-withheld-on-free-competition",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.open.slug}/participants`,
    present: ["Peserta"],
    // Paired with the case above. A free competition has no bukti transfer and never will, so the
    // link would lead to a queue that is permanently empty by construction.
    absent: ["Verifikasi pembayaran"],
    why: "an organiser must not be sent to a surface that can never have anything on it",
  },
  {
    id: "organiser-queue-outsider-dual-into-d",
    // OUTSIDER ONE: staff at institution A only, reaching for institution D's competition.
    as: "dual",
    path: `/institution/${INST.d.slug}/competitions/${COMP.dPaid.slug}/payments`,
    present: [],
    // The membership gate redirects, so `main` never carries the queue. Asserting the ACTIONS are
    // absent rather than asserting a 403: the failure that matters is a verdict control reachable
    // by someone outside the tenant, whatever the status code says.
    absent: ["Verifikasi pembayaran", "Verifikasi", "Tolak", "Lihat bukti"],
    why: "a recruiter at another institution must not reach D's queue, let alone act on it",
  },
  {
    id: "organiser-queue-outsider-recmin-into-a",
    // OUTSIDER TWO, the other direction: owner of D and P, reaching for institution A's
    // competition. Not the same assertion as above — this one is an OWNER rather than staff, and
    // the institution they do administer has a paid competition of its own, so a scope keyed to
    // "has any paid competition" would let them through.
    as: "recMin",
    path: `/institution/${INST.a.slug}/competitions/${COMP.paid.slug}/payments`,
    present: [],
    absent: ["Verifikasi pembayaran", "Verifikasi", "Tolak", "Lihat bukti"],
    why: "administering one institution's paid competition grants nothing at another's",
  },
  {
    id: "organiser-queue-owner-sees-own-tenant",
    // The pairing that makes the two outsider cases mean something: the SAME user, at the
    // institution they do administer, sees the queue. Without it both absent-assertions above would
    // pass against a page that renders nothing for anyone.
    as: "recMin",
    path: `/institution/${INST.d.slug}/competitions/${COMP.dPaid.slug}/payments`,
    present: ["Verifikasi pembayaran", "Verifikasi", "Tolak", "Lihat bukti"],
    absent: [],
    why: "proves the outsider assertions are about the tenant boundary and not about a blank page",
  },

  // ── Surface 3: where the institution wants to be paid ─────────────────────────────────────────
  {
    id: "payment-instructions-owner",
    as: "recElev",
    path: `/institution/${INST.a.slug}/settings`,
    present: [
      "Informasi pembayaran",
      "Nomor rekening",
      "Nama pemilik rekening",
      // DEC-0130 stated to the person entering the digits, which is the only place it changes
      // anyone's behaviour.
      "Lombakita tidak menampung dana",
    ],
    absent: [],
    why: "the owner must be able to publish an account, and be told the platform never holds the money",
  },
  {
    id: "payment-instructions-withheld-from-staff",
    // OUTSIDER ONE, and the substantive access decision on this surface: staff at THIS institution.
    // Staff already rule on whether a transfer arrived; letting them also set where transfers go
    // puts both halves of "redirect the money and confirm it received" in one pair of hands.
    as: "dual",
    path: `/institution/${INST.a.slug}/settings`,
    present: [],
    absent: ["Informasi pembayaran", "Nomor rekening"],
    why: "a staff member must not be able to repoint the institution's bank account",
  },
  {
    id: "payment-instructions-withheld-from-other-owner",
    // OUTSIDER TWO, the other direction: an owner — of D and P — at institution A. Not the same
    // assertion as above, because this one is an OWNER and would pass any check that asked only
    // whether the caller owns something.
    as: "recMin",
    path: `/institution/${INST.a.slug}/settings`,
    present: [],
    absent: ["Informasi pembayaran", "Nomor rekening"],
    why: "owning one institution grants nothing at another's banking settings",
  },
  {
    id: "payment-instructions-own-tenant",
    // The pairing that makes both absences meaningful: the SAME user, at the institution they own.
    as: "recMin",
    path: `/institution/${INST.d.slug}/settings`,
    present: ["Informasi pembayaran", "Nomor rekening"],
    absent: [],
    why: "proves the two absences are the tenant boundary, not a page that renders nothing",
  },

  // ── Surface 5: the DEC-0131 cancel affordance ─────────────────────────────────────────────────
  {
    id: "cancel-offered-nothing-sent",
    as: "candA",
    path: "/competitions/seed-academy/seed-paid/registration",
    // THE PRESENT HALF. Without it the two absent-assertions below would pass on any page that
    // failed to render the registration state at all.
    present: ["Batalkan pendaftaran", "Pembatalan tunduk pada kebijakan penyelenggara"],
    absent: ["tidak dapat dibatalkan sendiri"],
    why: "a candidate who owes money and has sent none keeps the right to leave",
  },
  {
    id: "cancel-withheld-proof-under-review",
    as: "candB",
    path: "/competitions/seed-academy/seed-paid/registration",
    present: ["tidak dapat dibatalkan sendiri setelah bukti transfer dikirim"],
    // WITHHELD, not disabled. The control's words must be off the page entirely.
    absent: ["Batalkan pendaftaran"],
    why: "the candidate has asserted a transfer the platform cannot verify or reverse",
  },
  {
    id: "cancel-withheld-proof-rejected",
    as: "candC",
    path: "/competitions/seed-academy/seed-paid/registration",
    present: ["tidak dapat dibatalkan sendiri setelah bukti transfer dikirim"],
    absent: ["Batalkan pendaftaran"],
    why: "a rejection means the organiser was unconvinced, not that no money moved",
  },

  // ── Surface 4: enabling paid registration, with the disclosure ────────────────────────────────
  {
    id: "fee-disclosure-on-paid-competition",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.paid.slug}/edit`,
    present: [
      "Biaya pendaftaran",
      "Rincian per pendaftaran",
      // UPPERCASE because `.detail-grid dt` sets text-transform and innerText returns RENDERED
      // text. Written from the source string these three silently missed — the same shape as the
      // non-breaking space in `Rp\u00a0150.000`: the expectation was wrong, not the render.
      "DIBAYAR PESERTA",
      "BIAYA LAYANAN LOMBAKITA",
      "DITERIMA LEMBAGA ANDA",
      // The FIGURES, not just the labels. 250 bps on Rp 150.000 is Rp 3.750, leaving Rp 146.250 —
      // asserting the arithmetic reached the screen, since a disclosure showing the wrong number
      // is worse than one showing none.
      "Rp\u00a0150.000",
      "Rp\u00a03.750",
      "Rp\u00a0146.250",
      "Saya menyetujui rincian biaya layanan di atas.",
    ],
    absent: [],
    why: "consent to a bill is worthless unless the amount being consented to is on the screen",
  },
  {
    id: "fee-disclosure-withheld-on-free-competition",
    as: "recElev",
    path: `/institution/${INST.a.slug}/competitions/${COMP.open.slug}/edit`,
    present: ["Biaya pendaftaran", "Pendaftaran gratis"],
    // Paired with the case above. A free competition has no amount, so there is nothing to
    // disclose and nothing to consent to — the acknowledgement must not be reachable.
    absent: ["Rincian per pendaftaran", "Saya menyetujui rincian biaya layanan di atas."],
    why: "an acknowledgement offered against a blank disclosure records consent to nothing",
  },
];

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const targets = CASES.filter((c) => !filter || filter.test(c.id));

if (targets.length === 0) {
  console.error(`No UI state cases matched ${process.argv[2]}`);
  process.exit(1);
}

/**
 * Refuses to run at all when the app is not up.
 *
 * Without this the first `contextFor` throws while minting a session and the run dies with a
 * stack trace about credentials — which reads as "the seed accounts are broken", not "nothing is
 * listening on 3000". The likeliest misconfiguration by far is a forgotten dev server, so it gets
 * the one message that names itself.
 */
/**
 * One unasserted navigation, purely to make the dev server compile the route.
 *
 * Swallows everything: a warm-up that fails is not a result. If the route is genuinely broken the
 * measured navigation immediately after will say so, and it will say so about the real attempt.
 */
const warmRoute = async (page, path) => {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch {
    // Intentionally ignored.
  }
};

const assertAppReachable = async () => {
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) });
    // Any answer proves something is serving. `degraded` is fine — these assertions read pages,
    // not connectors.
    if (response.status !== 200 && response.status !== 503) {
      throw new Error(`unexpected status ${response.status}`);
    }
  } catch (error) {
    console.error(
      `Nothing is serving ${BASE} (${String(error).slice(0, 120)}).\n` +
        `These assertions need the app RUNNING and the matrix SEEDED:\n` +
        `  node --import tsx scripts/seed-test-matrix.ts\n` +
        `  npm run dev\n` +
        `This is a FAILURE, not a skip. A UI-state harness that quietly passes when the app is ` +
        `absent reports success for every surface it was supposed to be checking.`,
    );
    process.exit(1);
  }
};

await assertAppReachable();

const browser = await launch();
const misses = [];

for (const testCase of targets) {
  let context;
  try {
    // Inside the try because minting a session is itself a thing that fails, and a failure here
    // must be reported against the case rather than crashing the run.
    context = await contextFor(browser, USERS[testCase.as].email);
    const page = await context.newPage();
    await page.setViewportSize(DESKTOP);

    // WARM THE ROUTE FIRST. On a dev server the first request to a route it has not compiled can
    // exceed the navigation budget on its own, and that failure arrives looking exactly like a
    // surface that did not render — which is how a real signal gets dismissed as "just flaky".
    // The warm-up is unmeasured; only the second navigation is asserted against.
    await warmRoute(page, testCase.path);

    await page.goto(`${BASE}${testCase.path}`, { waitUntil: "networkidle" });
    const text = await page.locator("main").innerText();

    for (const needle of testCase.present) {
      if (!text.includes(needle)) {
        misses.push(`${testCase.id}: MISSING "${needle}" — ${testCase.why}`);
      }
    }
    for (const needle of testCase.absent) {
      if (text.includes(needle)) {
        misses.push(`${testCase.id}: OFFERED "${needle}" but it must be WITHHELD — ${testCase.why}`);
      }
    }
  } catch (error) {
    const detail = String(error).slice(0, 160);
    // A timeout that survives the warm-up is still more likely to be compilation than a defect, so
    // the message says so rather than leaving the reader to choose between two explanations.
    const hint = /Timeout/.test(detail) ? " — COLD COMPILE SUSPECTED, RE-RUN before treating this as a product defect" : "";
    misses.push(`${testCase.id}: could not be checked — ${detail}${hint}`);
  } finally {
    await context?.close();
  }
}

await browser.close();

if (misses.length > 0) {
  for (const miss of misses) console.error(miss);
  console.error(`\n${misses.length} miss(es) across ${targets.length} surface(s).`);
  process.exit(1);
}

console.log(`${targets.length}/${targets.length} surfaces render and withhold correctly.`);
