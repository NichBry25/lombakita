import { PAGES } from "./pages.mjs";

/*
 * The gallery's states on top of PAGES: the routes PAGES leaves out, every seeded status of a page
 * whose look depends on one, the empty states and the validation errors. Only gallery.mjs captures
 * this list, and only when GALLERY_WIDTHS is set. The contrast and mobile audits import pages.mjs
 * alone, so this file is never evaluated by them and nothing here is measured by them.
 *
 * An entry id is the id prefix of its path, then its state unless the prefix already names it, then
 * `--` and its role key. A path that PAGES lists takes the id of its first PAGES entry as its
 * prefix. Every other path takes its number from NEW_PATH_NUMBERS and its route part from the path
 * itself.
 */

// Every seeded account that can hold a session. `susp` and `unver` are refused at sign-in.
const SIGNED_IN = [
  "candA",
  "candB",
  "candC",
  "recMin",
  "recElev",
  "recRej",
  "recDraft",
  "dual",
  "ops",
  "opsEnrol",
  "opsChal",
  "finOps",
];
// Owner and staff of seed-academy, the two accounts its management pages open for.
const ACADEMY_ADMINS = ["recElev", "dual"];

const PHASE_SLUGS = {
  draft: "seed-draft",
  upcoming: "seed-upcoming",
  open: "seed-open",
  closing: "seed-closing",
  closed: "seed-closed",
  inprogress: "seed-inprogress",
  awaiting: "seed-awaiting",
  overdue: "seed-overdue",
  done: "seed-done",
};
const PUBLIC_PHASES = Object.keys(PHASE_SLUGS).filter((phase) => phase !== "draft");
const ALL_PHASES = Object.keys(PHASE_SLUGS);

const NEW_PATH_NUMBERS = new Map(
  [
    "/auth/sign-in",
    "/auth/signup",
    "/finance",
    "/competitions/seed-academy/seed-closed/registration",
    "/competitions/seed-academy/seed-inprogress/registration",
    "/competitions/seed-academy/seed-awaiting/registration",
    "/competitions/seed-academy/seed-overdue/registration",
    "/competitions/seed-academy/seed-done/registration",
    "/institution/seed-academy/competitions/seed-draft",
    "/institution/seed-academy/competitions/seed-upcoming",
    "/institution/seed-academy/competitions/seed-closing",
    "/institution/seed-academy/competitions/seed-closed",
    "/institution/seed-academy/competitions/seed-inprogress",
    "/institution/seed-academy/competitions/seed-awaiting",
    "/institution/seed-academy/competitions/seed-overdue",
    "/institution/seed-academy/competitions/seed-done",
    "/institution/seed-academy/competitions/seed-upcoming/edit",
    "/institution/seed-academy/competitions/seed-closing/edit",
    "/institution/seed-academy/competitions/seed-closed/edit",
    "/institution/seed-academy/competitions/seed-inprogress/edit",
    "/institution/seed-academy/competitions/seed-awaiting/edit",
    "/institution/seed-academy/competitions/seed-overdue/edit",
    "/institution/seed-academy/competitions/seed-done/edit",
    "/institution/seed-academy/competitions/seed-draft/participants",
    "/institution/seed-academy/competitions/seed-upcoming/participants",
    "/institution/seed-academy/competitions/seed-closing/participants",
    "/institution/seed-academy/competitions/seed-inprogress/participants",
    "/institution/seed-academy/competitions/seed-awaiting/participants",
    "/institution/seed-academy/competitions/seed-overdue/participants",
    "/candidate-dashboard/registrations/seed-reg-a-open",
    "/candidate-dashboard/registrations/seed-reg-a-feat-cxl",
    "/candidate-dashboard/registrations/seed-reg-tb-b",
    "/candidate-dashboard/registrations/seed-reg-tb-c",
    "/candidate-dashboard/registrations/seed-reg-c-open",
    "/candidate-dashboard/registrations/seed-reg-b-done",
    "/candidate-dashboard/registrations/seed-reg-a-dpaid",
    // Listed without entries so the numbers after it stay fixed.
    "/candidate-dashboard/results/seed-reg-b-done",
    "/institution/seed-academy/competitions/seed-open/participants/seed-reg-a-open",
    "/institution/seed-academy/competitions/seed-featured/participants/seed-reg-a-feat-cxl",
    "/institution/seed-academy/competitions/seed-closing/participants/seed-reg-tb-b",
    "/institution/seed-academy/competitions/seed-closing/participants/seed-reg-tb-c",
    "/institution/seed-academy/competitions/seed-open/participants/seed-reg-c-open",
    "/institution/seed-academy/competitions/seed-done/participants/seed-reg-b-done",
    "/institution/seed-academy/competitions/seed-inprogress/participants/seed-reg-a-inprog",
    "/institution/seed-academy/competitions/seed-paid/participants/seed-reg-a-paid",
    "/institution/seed-academy/competitions/seed-paid/participants/seed-reg-b-paid",
    "/institution/seed-academy/competitions/seed-paid/participants/seed-reg-c-paid",
    "/institution/seed-kolektif/competitions/seed-kolektif-paid/participants/seed-reg-a-dpaid",
    "/institution/seed-academy/competitions/seed-paid/participants/seed-reg-d-paid",
    "/finance/payments/seed-pay-a",
    "/finance/payments/seed-pay-c",
    "/finance/payments/seed-pay-d",
    "/finance/payments/seed-pay-d-settled",
    "/institution/seed-kolektif/competitions/seed-kolektif-paid/payments",
    "/institution/seed-academy/competitions/seed-team-open/participants",
    "/institution/seed-kolektif/team",
    "/institution/seed-kolektif/audit-log",
    "/auth/verify-role?as=candidate",
    "/competitions/seed-academy/seed-team-open/registration",
  ].map((path, index) => [path, 97 + index]),
);

const routePartOf = (path) => path.split("?")[0].slice(1).replaceAll("/", "-");

const idPrefixOf = (path) => {
  const listed = PAGES.find((page) => page.path === path);
  if (listed) return listed.id;
  const number = NEW_PATH_NUMBERS.get(path);
  if (number === undefined) throw new Error(`state-pages.mjs: no id number for ${path}`);
  return `${number}-${routePartOf(path)}`;
};

const isInPages = (path, as) => PAGES.some((page) => page.path === path && page.as === as);

// A prefix that already names the state would say it twice (06-detail-open-open), so it is kept as is.
const stemFor = (path, state) => {
  const prefix = idPrefixOf(path);
  if (!state) return prefix;
  const namesState = prefix.endsWith(`-${state}`) || prefix.includes(`seed-${state}`);
  return namesState ? prefix : `${prefix}-${state}`;
};

const entryFor = (path, as, state, interact) => {
  const stem = stemFor(path, state);
  const id = `${stem}--${as ?? "anon"}`;
  return {
    id,
    as,
    path,
    label: id,
    ...(state ? { state } : {}),
    ...(interact ? { interact } : {}),
  };
};

// One entry per role for a path in one seeded state, plus signed out when `withAnon` is set. A role
// that a PAGES entry already shows on this path is left out, because that shot exists.
const stateEntries = (path, state, roles, { withAnon = false } = {}) => {
  const accounts = withAnon ? [...roles, null] : roles;
  return accounts.filter((as) => !isInPages(path, as)).map((as) => entryFor(path, as, state));
};

const routeEntries = [
  entryFor("/auth/sign-in", null),
  entryFor("/auth/signup", null),
  entryFor("/finance", "finOps"),
];

const phaseEntries = [
  ...PUBLIC_PHASES.flatMap((phase) =>
    stateEntries(`/competitions/seed-academy/${PHASE_SLUGS[phase]}`, phase, SIGNED_IN, {
      withAnon: true,
    }),
  ),
  ...PUBLIC_PHASES.flatMap((phase) =>
    stateEntries(
      `/competitions/seed-academy/${PHASE_SLUGS[phase]}/registration`,
      phase,
      SIGNED_IN,
      { withAnon: true },
    ),
  ),
  ...["", "/edit", "/participants"].flatMap((suffix) =>
    ALL_PHASES.flatMap((phase) =>
      stateEntries(
        `/institution/seed-academy/competitions/${PHASE_SLUGS[phase]}${suffix}`,
        phase,
        ACADEMY_ADMINS,
        { withAnon: true },
      ),
    ),
  ),
];

// [registration id, owner, state] for the candidate's registration page and the organiser's review.
const REGISTRATION_STATES = [
  ["seed-reg-a-open", "candA", "confirmed"],
  ["seed-reg-a-feat-cxl", "candA", "cancelled"],
  ["seed-reg-tb-b", "candB", "team"],
  ["seed-reg-tb-c", "candC", "team"],
  ["seed-reg-c-open", "candC", "document-lapsed"],
  ["seed-reg-b-done", "candB", "result-draft"],
  ["seed-reg-a-inprog", "candA", "document-requested"],
  ["seed-reg-a-done", "candA", "result-published"],
  ["seed-reg-a-paid", "candA", "awaiting-transfer"],
  ["seed-reg-b-paid", "candB", "proof-pending"],
  ["seed-reg-c-paid", "candC", "proof-rejected"],
  ["seed-reg-a-dpaid", "candA", "proof-pending"],
];
// The competition each registration belongs to, as its organiser's review path addresses it.
const REVIEW_PATHS = {
  "seed-reg-a-open": "seed-academy/competitions/seed-open",
  "seed-reg-a-feat-cxl": "seed-academy/competitions/seed-featured",
  "seed-reg-tb-b": "seed-academy/competitions/seed-closing",
  "seed-reg-tb-c": "seed-academy/competitions/seed-closing",
  "seed-reg-c-open": "seed-academy/competitions/seed-open",
  "seed-reg-b-done": "seed-academy/competitions/seed-done",
  "seed-reg-a-inprog": "seed-academy/competitions/seed-inprogress",
  "seed-reg-a-done": "seed-academy/competitions/seed-done",
  "seed-reg-a-paid": "seed-academy/competitions/seed-paid",
  "seed-reg-b-paid": "seed-academy/competitions/seed-paid",
  "seed-reg-c-paid": "seed-academy/competitions/seed-paid",
  "seed-reg-d-paid": "seed-academy/competitions/seed-paid",
  "seed-reg-a-dpaid": "seed-kolektif/competitions/seed-kolektif-paid",
};

const registrationEntries = [
  ...REGISTRATION_STATES.flatMap(([registrationId, owner, state]) =>
    stateEntries(`/candidate-dashboard/registrations/${registrationId}`, state, [owner], {
      withAnon: true,
    }),
  ),
  // Both registrations belong to seed-team-b, so its member can open them as well as its captain.
  ...stateEntries("/candidate-dashboard/registrations/seed-reg-tb-b", "team", ["candC"]),
  ...stateEntries("/candidate-dashboard/registrations/seed-reg-tb-c", "team", ["candB"]),
  ...stateEntries("/candidate-dashboard/results/seed-reg-a-done", "published", ["candA"], {
    withAnon: true,
  }),
  // seed-reg-d-paid belongs to a candidate seeds.mjs has no session for, so only its organiser
  // view is shot.
  ...[...REGISTRATION_STATES, ["seed-reg-d-paid", null, "settled"]].flatMap(
    ([registrationId, , state]) => {
      const competitionPath = REVIEW_PATHS[registrationId];
      const admins = competitionPath.startsWith("seed-kolektif/") ? ["recMin"] : ACADEMY_ADMINS;
      return stateEntries(
        `/institution/${competitionPath}/participants/${registrationId}`,
        state,
        admins,
        { withAnon: true },
      );
    },
  ),
];

const paymentEntries = [
  ...[
    ["seed-pay-a", "awaiting-transfer"],
    ["seed-pay-b", "proof-pending"],
    ["seed-pay-c", "proof-rejected"],
    ["seed-pay-d", "proof-pending"],
    ["seed-pay-d-settled", "settled"],
  ].flatMap(([paymentId, state]) =>
    stateEntries(`/finance/payments/${paymentId}`, state, ["finOps"], { withAnon: true }),
  ),
  ...stateEntries(
    "/institution/seed-academy/competitions/seed-paid/payments",
    "mixed",
    ACADEMY_ADMINS,
    {
      withAnon: true,
    },
  ),
  ...stateEntries(
    "/institution/seed-academy/competitions/seed-open/payments",
    "empty",
    ACADEMY_ADMINS,
    {
      withAnon: true,
    },
  ),
  ...stateEntries(
    "/institution/seed-kolektif/competitions/seed-kolektif-paid/payments",
    "proof-pending",
    ["recMin"],
    { withAnon: true },
  ),
];

const verificationAndInvitationEntries = [
  ...stateEntries("/institution/seed-academy/verification", "verified", ACADEMY_ADMINS, {
    withAnon: true,
  }),
  ...stateEntries("/institution/seed-ventures/verification", "pending-review", ["recElev"], {
    withAnon: true,
  }),
  ...stateEntries("/institution/seed-rec-min/verification", "pending", ["recMin"], {
    withAnon: true,
  }),
  ...stateEntries("/institution/seed-academy/team", "invitations-pending", ACADEMY_ADMINS, {
    withAnon: true,
  }),
];

const emptyEntries = [
  entryFor("/inbox", "candC", "empty"),
  entryFor("/saved", "candB", "empty"),
  entryFor("/candidate-dashboard/results", "candC", "empty"),
  entryFor(
    "/institution/seed-academy/competitions/seed-team-open/participants",
    "recElev",
    "empty",
  ),
  entryFor("/institution/seed-kolektif/team", "recMin", "empty"),
  entryFor("/institution/seed-kolektif/audit-log", "recMin", "empty"),
];

// Each interaction submits its form with every field empty and types nothing. A form that opens
// filled in has its required fields cleared first.
const submitFormOf = (fieldSelector) => async (page) => {
  await page
    .locator("form", { has: page.locator(fieldSelector) })
    .locator('button[type="submit"]')
    .first()
    .click();
};

const clearThenSubmitFormOf = (fieldSelectors) => async (page) => {
  for (const selector of fieldSelectors) {
    await page.fill(selector, "");
  }
  await submitFormOf(fieldSelectors[0])(page);
};

const pressActionBar = (buttonName) => async (page) => {
  await page
    .locator(".form-action-bar-end")
    .getByRole("button", { name: buttonName, exact: true })
    .click();
};

const clearThenPressActionBar = (fieldSelectors, buttonName) => async (page) => {
  for (const selector of fieldSelectors) {
    await page.fill(selector, "");
  }
  await pressActionBar(buttonName)(page);
};

const clearLabelledFieldsThenPressActionBar = (labels, buttonName) => async (page) => {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelWithOptionalMarker = new RegExp(
      `^${escapedLabel}(?: \\* \\(wajib\\)| \\(opsional\\))?$`,
    );
    await page
      .locator("label.form-field")
      .filter({ has: page.locator("span.form-label", { hasText: labelWithOptionalMarker }) })
      .locator("input, textarea")
      .fill("");
  }
  await pressActionBar(buttonName)(page);
};

const clickControl = (selector) => async (page) => {
  await page.locator(selector).click();
};

const validationErrorEntry = (path, as, interact) =>
  entryFor(path, as, "validation-error", interact);

const validationErrorEntries = [
  validationErrorEntry(
    "/candidate-dashboard/profile",
    "candA",
    clearThenPressActionBar(
      ["#candidate-full-name", "#candidate-phone", "#candidate-dob"],
      "Simpan",
    ),
  ),
  validationErrorEntry(
    "/profile/edit",
    "candA",
    clearThenPressActionBar(["#profile-username"], "Simpan"),
  ),
  validationErrorEntry("/auth/change-password", "candA", submitFormOf("#change-current-password")),
  validationErrorEntry("/auth/forgot-password", null, submitFormOf("#forgot-password-email")),
  validationErrorEntry("/auth/reset-password?token=seed-placeholder-token", null, async (page) => {
    await page.getByRole("button", { name: "Simpan password baru", exact: true }).click();
  }),
  // The host step asks nothing required, so its error state is the Email organisasi sent empty,
  // which the code route refuses before any write. Pressing the host step button would grant the role.
  validationErrorEntry(
    "/auth/verify-role?as=recruiter",
    "candA",
    submitFormOf("#organization-email"),
  ),
  validationErrorEntry(
    "/auth/verify-role?as=candidate",
    "recMin",
    clickControl('[data-testid="verify-role-candidate"]'),
  ),
  validationErrorEntry("/institution/create", "recElev", pressActionBar("Buat institusi")),
  validationErrorEntry(
    "/institution/seed-academy/competitions/new",
    "recElev",
    pressActionBar("Lanjut"),
  ),
  validationErrorEntry(
    "/institution/seed-academy/competitions/seed-draft/edit?langkah=1",
    "recElev",
    clearLabelledFieldsThenPressActionBar(["Judul", "Deskripsi"], "Lanjut"),
  ),
  validationErrorEntry(
    "/institution/seed-academy/settings",
    "recElev",
    clearThenPressActionBar(
      ["#institution-settings-display-name", "#institution-settings-slug"],
      "Simpan",
    ),
  ),
  validationErrorEntry(
    "/institution/seed-academy/team",
    "recElev",
    submitFormOf("#institution-invite-identifier"),
  ),
  validationErrorEntry(
    "/admin/fee-rules",
    "ops",
    clearThenSubmitFormOf(["#fee-rule-basis-points"]),
  ),
  validationErrorEntry(
    "/competitions/seed-academy/seed-team-open/registration",
    "candA",
    async (page) => {
      await page
        .locator("form.team-inline-form", { has: page.getByPlaceholder("Nama tim") })
        .getByRole("button", { name: "Buat tim", exact: true })
        .click();
    },
  ),
  validationErrorEntry(
    "/institution/seed-academy/competitions/seed-open/participants",
    "recElev",
    async (page) => {
      await page.locator('button[aria-controls="batch-document-request"]').click();
      await page.locator('#batch-document-request button[type="submit"]').click();
    },
  ),
  validationErrorEntry(
    "/institution/seed-academy/competitions/seed-open/participants/seed-reg-a-open",
    "recElev",
    submitFormOf("#document-request-title"),
  ),
  validationErrorEntry("/recruiter-dashboard", "recDraft", submitFormOf("#organization-email")),
];

export const STATE_PAGES = [
  ...routeEntries,
  ...phaseEntries,
  ...registrationEntries,
  ...paymentEntries,
  ...verificationAndInvitationEntries,
  ...emptyEntries,
  ...validationErrorEntries,
];
