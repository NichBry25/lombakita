/**
 * Page inventory for the design gallery. `as` selects the session; `id` becomes the file stem.
 * Every one of the 47 route segments in src/app appears at least once, in the mode(s) that
 * make it meaningful.
 */
export const PAGES = [
  // ---------------------------------------------------------------- signed out
  { id: "01-home", as: null, path: "/", label: "Landing page" },
  { id: "02-competitions", as: null, path: "/competitions", label: "Public competition listing" },
  {
    id: "03-competitions-filtered",
    as: null,
    path: "/competitions?category=hackathon&sort=deadline_asc",
    label: "Listing with category filter + sort",
  },
  {
    id: "04-competitions-all-status",
    as: null,
    path: "/competitions?status=all",
    label: "Listing including finished competitions",
  },
  {
    id: "05-competitions-search",
    as: null,
    path: "/competitions?q=hackathon",
    label: "Listing with search query",
  },
  {
    id: "06-detail-open",
    as: null,
    path: "/competitions/seed-academy/seed-open",
    label: "Detail — registration open (prizes, rounds, tags)",
  },
  {
    id: "07-detail-upcoming",
    as: null,
    path: "/competitions/seed-academy/seed-upcoming",
    label: "Detail — not yet open (CTA disabled)",
  },
  {
    id: "08-detail-closing",
    as: null,
    path: "/competitions/seed-academy/seed-closing",
    label: "Detail — closing soon badge",
  },
  {
    id: "09-detail-closed",
    as: null,
    path: "/competitions/seed-academy/seed-closed",
    label: "Detail — registration closed",
  },
  {
    id: "10-detail-inprogress",
    as: null,
    path: "/competitions/seed-academy/seed-inprogress",
    label: "Detail — event in progress",
  },
  {
    id: "11-detail-awaiting",
    as: null,
    path: "/competitions/seed-academy/seed-awaiting",
    label: "Detail — awaiting results",
  },
  {
    id: "12-detail-overdue",
    as: null,
    path: "/competitions/seed-academy/seed-overdue",
    label: "Detail — results overdue",
  },
  {
    id: "13-detail-done",
    as: null,
    path: "/competitions/seed-academy/seed-done",
    label: "Detail — results announced (archive stays public)",
  },
  {
    id: "14-detail-personal-org",
    as: null,
    path: "/competitions/seed-rec-min/seed-personal-open",
    label: "Detail — personal institution organizer (derived identity)",
  },
  {
    id: "15-institution-public",
    as: null,
    path: "/institution/seed-academy",
    label: "Public institution page (signed out)",
  },
  { id: "16-profile-public", as: null, path: "/seed_cand_a", label: "Public user profile" },
  { id: "17-auth-login", as: null, path: "/auth/login", label: "Auth entry (method-first)" },
  {
    id: "18-auth-login-as-recruiter",
    as: null,
    path: "/auth/login?as=recruiter",
    label: "Auth entry with role hint",
  },
  {
    id: "19-auth-register-redirect",
    as: null,
    path: "/auth/register",
    label: "/auth/register → login redirect",
  },
  {
    id: "20-auth-verify-request",
    as: null,
    path: "/auth/verify-request",
    label: "Verification email sent notice",
  },
  { id: "21-auth-activated", as: null, path: "/auth/activated", label: "Account activated notice" },
  {
    id: "22-auth-verify-email-bad",
    as: null,
    path: "/auth/verify-email?token=invalid-seed-token",
    label: "Email verification — invalid token state",
  },
  { id: "23-suspended", as: null, path: "/suspended", label: "Suspended account notice" },
  {
    id: "24-protected-anon",
    as: null,
    path: "/protected",
    label: "Protected route while signed out",
  },
  {
    id: "25-registration-anon",
    as: null,
    path: "/competitions/seed-academy/seed-open/registration",
    label: "Registration subpage while signed out",
  },
  {
    id: "26-detail-404",
    as: null,
    path: "/competitions/seed-academy/tidak-ada-slug",
    label: "Competition 404",
  },
  {
    id: "27-dev-primitives",
    as: null,
    path: "/dev/primitives",
    label: "UI primitives dev surface",
  },

  // The public legal and identity surfaces. Nothing walks the route tree, so a page that is not
  // listed here is never visited by the contrast audit, the mobile audit or the gallery, and passes
  // every one of them by never being measured. The letter suffixes keep all four inside the one
  // free slot left in the signed-out band rather than renumbering every id below.
  { id: "28-kontak", as: null, path: "/kontak", label: "Company identity and contact" },
  {
    id: "28a-syarat-ketentuan",
    as: null,
    path: "/syarat-ketentuan",
    label: "Terms of service",
  },
  {
    id: "28b-kebijakan-privasi",
    as: null,
    path: "/kebijakan-privasi",
    label: "Privacy policy",
  },
  { id: "28c-tentang", as: null, path: "/tentang", label: "About, how to register, fees" },

  // ---------------------------------------------------------------- candidate
  {
    id: "30-candidate-dashboard",
    as: "candA",
    path: "/candidate-dashboard",
    label: "Candidate dashboard",
  },
  {
    id: "31-candidate-profile",
    as: "candA",
    path: "/candidate-dashboard/profile",
    label: "Candidate onboarding profile",
  },
  {
    id: "26-registration-unpayable",
    as: "candA",
    path: "/competitions/seed-ventures/seed-b-unpayable/registration",
    label: "Registration subpage — paid, organiser cannot take payment",
  },
  {
    id: "32-registration-detail-docreq",
    as: "candA",
    path: "/candidate-dashboard/registrations/seed-reg-a-inprog",
    label: "Registration detail — open document request",
  },
  {
    id: "33-registration-detail-finalized",
    as: "candA",
    path: "/candidate-dashboard/registrations/seed-reg-a-done",
    label: "Registration detail — finalized submission",
  },
  // The manual payment lane in each of the three states a candidate can be in. Three pages rather
  // than one because the panel renders differently in each and a single sample would audit only the
  // state that happened to be seeded.
  {
    id: "33a-payment-awaiting-transfer",
    as: "candA",
    path: "/candidate-dashboard/registrations/seed-reg-a-paid",
    label: "Registration detail — payment owed, nothing sent",
  },
  {
    id: "33b-payment-awaiting-review",
    as: "candB",
    path: "/candidate-dashboard/registrations/seed-reg-b-paid",
    label: "Registration detail — bukti transfer awaiting review",
  },
  {
    id: "33c-payment-rejected",
    as: "candC",
    path: "/candidate-dashboard/registrations/seed-reg-c-paid",
    label: "Registration detail — bukti transfer rejected, resubmittable",
  },
  {
    id: "34-results-list",
    as: "candA",
    path: "/candidate-dashboard/results",
    label: "Candidate results list",
  },
  {
    id: "35-result-detail",
    as: "candA",
    path: "/candidate-dashboard/results/seed-reg-a-done",
    label: "Published result detail",
  },
  { id: "36-saved", as: "candA", path: "/saved", label: "Saved competitions" },
  {
    id: "37-inbox",
    as: "candA",
    path: "/inbox",
    label: "Notification inbox (notifs + pending invite)",
  },
  { id: "38-profile-owner", as: "candA", path: "/profile", label: "Owner profile view" },
  { id: "39-profile-edit", as: "candA", path: "/profile/edit", label: "Profile editor" },
  {
    id: "40-registration-both-mode",
    as: "candA",
    path: "/competitions/seed-academy/seed-open/registration",
    label: "Registration subpage — both modes",
  },
  {
    id: "41-registration-team-mode",
    as: "candA",
    path: "/competitions/seed-academy/seed-closing/registration",
    label: "Registration subpage — team mode",
  },
  // The cancel affordance in all three states DEC-0131 distinguishes. Registered here rather than
  // folded into 40/41 because the withheld state only exists on a PRICED competition and only once
  // a bukti transfer has been filed, neither of which the free fixtures can produce.
  {
    id: "42a-registration-paid-cancellable",
    as: "candA",
    path: "/competitions/seed-academy/seed-paid/registration",
    label: "Registration subpage — paid, cancel still offered",
  },
  {
    id: "42b-registration-paid-withheld",
    as: "candB",
    path: "/competitions/seed-academy/seed-paid/registration",
    label: "Registration subpage — cancel withheld, proof under review",
  },
  {
    id: "42c-registration-paid-withheld-rejected",
    as: "candC",
    path: "/competitions/seed-academy/seed-paid/registration",
    label: "Registration subpage — cancel withheld, proof rejected",
  },
  {
    id: "42-detail-as-candidate",
    as: "candA",
    path: "/competitions/seed-academy/seed-featured",
    label: "Detail as signed-in candidate (save control)",
  },
  {
    id: "43-institution-public-as-candidate",
    as: "candA",
    path: "/institution/seed-academy",
    label: "Public institution page as candidate",
  },
  {
    id: "44-verify-role-recruiter",
    as: "candA",
    path: "/auth/verify-role?as=recruiter",
    label: "Second-role verification entry",
  },
  { id: "45-verify-tier", as: "candA", path: "/auth/verify-tier", label: "Tier verification stub" },
  { id: "46-post-login", as: "candA", path: "/auth/post-login", label: "Post-login forwarder" },
  {
    id: "47-candidate-on-institution",
    as: "candA",
    path: "/institution/seed-academy/competitions",
    label: "Candidate hitting an institution surface (guard)",
  },
  {
    id: "48-registration-team-captain",
    as: "candC",
    path: "/competitions/seed-academy/seed-upcoming/registration",
    label: "Registration subpage — forming team as captain",
  },

  // ---------------------------------------------------------------- recruiter
  {
    id: "50-recruiter-dashboard-elev",
    as: "recElev",
    path: "/recruiter-dashboard",
    label: "Recruiter dashboard — Trusted (elevated)",
  },
  {
    id: "51-institution-board",
    as: "recElev",
    path: "/institution/seed-academy",
    label: "Institution management board",
  },
  // DEC-0170's organiser panel. Paired with 51 above, which is the verified institution and must
  // NOT show it.
  {
    id: "51b-institution-board-unpayable",
    as: "recElev",
    path: "/institution/seed-ventures",
    label: "Institution board — cannot charge (all three blockers)",
  },
  {
    id: "52-institution-public-preview",
    as: "recElev",
    path: "/institution/seed-academy?tampilan=publik",
    label: "Owner previewing the public page",
  },
  {
    id: "53-institution-competitions",
    as: "recElev",
    path: "/institution/seed-academy/competitions",
    label: "Institution competition list (phase filters)",
  },
  {
    id: "54-competition-new",
    as: "recElev",
    path: "/institution/seed-academy/competitions/new",
    label: "Create competition form",
  },
  {
    id: "55-competition-detail-mgmt",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open",
    label: "Competition management detail",
  },
  {
    id: "56-competition-edit",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open/edit",
    label: "Competition editor (published — immutable fields)",
  },
  {
    id: "57-competition-edit-draft",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit",
    label: "Competition editor (draft — all fields open)",
  },
  // Registered separately from 56/57 because only a PAID competition renders the fee disclosure:
  // three figures and an acknowledgement that exist on no other editor.
  {
    id: "57b-competition-edit-paid",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-paid/edit?langkah=4",
    label: "Competition editor — paid, with fee disclosure",
  },
  {
    id: "57c-competition-edit-draft-basics",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit?langkah=1",
    label: "Competition editor (draft, step 1 Informasi dasar)",
  },
  {
    id: "57d-competition-edit-draft-participants",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit?langkah=2",
    label: "Competition editor (draft, step 2 Peserta)",
  },
  {
    id: "57e-competition-edit-draft-schedule",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit?langkah=3",
    label: "Competition editor (draft, step 3 Jadwal)",
  },
  {
    id: "57f-competition-edit-draft-prizes-fee",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit?langkah=4",
    label: "Competition editor (draft, step 4 Hadiah dan biaya)",
  },
  {
    id: "57g-competition-edit-draft-review",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-draft/edit?langkah=5",
    label: "Competition editor (draft, step 5 Tinjau dan terbitkan)",
  },
  {
    id: "57h-competition-edit-published-participants",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open/edit?langkah=2",
    label: "Competition editor (published, section Peserta, minimum locked)",
  },
  {
    id: "57i-competition-edit-published-schedule",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open/edit?langkah=3",
    label: "Competition editor (published, section Jadwal, confirmation locked)",
  },
  {
    id: "58-participants",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open/participants",
    label: "Participants console",
  },
  {
    id: "59-participants-done",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-done/participants",
    label: "Participants console — finished competition",
  },
  {
    id: "60-participant-review",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-done/participants/seed-reg-a-done",
    label: "Participant review + result + documents",
  },
  {
    id: "61-participation-decision",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-closed/participants",
    label: "Minimum-entry decision surface",
  },
  // The organiser's verdict queue. Registered as ONE page carrying all three proof states at once
  // (pending, verified and rejected) because the tones for the settled two render nowhere else, and
  // an unmeasured tone is how a badge that styles nothing survives a full audit.
  {
    id: "61b-payment-verification",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-paid/payments",
    label: "Bukti transfer verification queue",
  },
  {
    id: "61c-payment-verification-empty",
    as: "recElev",
    path: "/institution/seed-academy/competitions/seed-open/payments",
    label: "Bukti transfer queue — nothing submitted yet",
  },
  {
    id: "61d-institution-fee-statement",
    as: "recElev",
    path: "/institution/seed-academy/fees",
    label: "Fee statement — what the institution owes Lombakita, priced at each accrual's own rate",
  },
  {
    id: "61e-institution-fee-statement-empty",
    as: "recMin",
    path: "/institution/seed-kolektif/fees",
    label: "Fee statement before an institution has charged anyone",
  },
  {
    id: "62-institution-team",
    as: "recElev",
    path: "/institution/seed-academy/team",
    label: "Institution members & invitations",
  },
  {
    id: "63-institution-settings",
    as: "recElev",
    path: "/institution/seed-academy/settings",
    label: "Institution settings",
  },
  {
    id: "64-institution-verification-full",
    as: "recElev",
    path: "/institution/seed-academy/verification",
    label: "Institution verification — verified panel",
  },
  {
    id: "65-institution-verification-pending",
    as: "recElev",
    path: "/institution/seed-ventures/verification",
    label: "Institution verification — pending panel",
  },
  {
    id: "66-institution-audit-log",
    as: "recElev",
    path: "/institution/seed-academy/audit-log",
    label: "Institution audit log",
  },
  {
    id: "67-institution-create",
    as: "recElev",
    path: "/institution/create",
    label: "Create full institution",
  },
  {
    id: "68-institution-personal-create",
    as: "recElev",
    path: "/institution/personal",
    label: "Create personal institution",
  },
  {
    id: "69-institution-board-pending",
    as: "recElev",
    path: "/institution/seed-ventures",
    label: "Institution board — pending verification",
  },
  {
    id: "70-institution-board-suspended",
    as: "recElev",
    path: "/institution/seed-suspended-org",
    label: "Institution board — suspended institution",
  },
  {
    id: "71-recruiter-dashboard-min",
    as: "recMin",
    path: "/recruiter-dashboard",
    label: "Recruiter dashboard — minimal tier, pending review",
  },
  {
    id: "72-personal-institution-board",
    as: "recMin",
    path: "/institution/seed-rec-min",
    label: "Personal institution board",
  },
  {
    id: "73-personal-upgrade",
    as: "recMin",
    path: "/institution/seed-rec-min/verification",
    label: "Personal institution upgrade surface",
  },
  {
    id: "74-personal-settings",
    as: "recMin",
    path: "/institution/seed-rec-min/settings",
    label: "Personal institution settings (name/slug locked)",
  },
  {
    id: "75-recruiter-dashboard-rejected",
    as: "recRej",
    path: "/recruiter-dashboard",
    label: "Recruiter dashboard — verification rejected + reason",
  },
  {
    id: "76-recruiter-dashboard-draft",
    as: "recDraft",
    path: "/recruiter-dashboard",
    label: "Recruiter dashboard — withdrawn draft warning",
  },
  {
    id: "77-inbox-recruiter-invite",
    as: "recRej",
    path: "/inbox",
    label: "Inbox with a pending institution invitation",
  },
  {
    id: "78-dual-dashboard",
    as: "dual",
    path: "/candidate-dashboard",
    label: "Dual-role account on the candidate side",
  },
  {
    id: "79-dual-recruiter",
    as: "dual",
    path: "/recruiter-dashboard",
    label: "Dual-role account on the recruiter side",
  },

  // ---------------------------------------------------------------- platform ops
  { id: "80-admin-hub", as: "ops", path: "/admin", label: "Platform ops hub" },
  {
    id: "81-admin-institutions",
    as: "ops",
    path: "/admin/institutions",
    label: "Institution verification table",
  },
  {
    id: "82-admin-moderation",
    as: "ops",
    path: "/admin/moderation",
    label: "Moderation & lookup console",
  },
  {
    id: "83-admin-moderation-user",
    as: "ops",
    path: "/admin/moderation?email=seed.cand.a@seed.lombakita.local",
    label: "Moderation — user lookup result",
  },
  {
    id: "84-admin-featured",
    as: "ops",
    path: "/admin/featured",
    label: "Featured placement controls",
  },
  {
    id: "85-admin-recruiter-verification",
    as: "ops",
    path: "/admin/recruiter-verification",
    label: "Recruiter verification queue",
  },
  {
    id: "86-admin-verification",
    as: "ops",
    path: "/admin/verification",
    label: "Institution document verification queue",
  },
  {
    id: "86b-admin-fee-rules",
    as: "ops",
    path: "/admin/fee-rules",
    label: "Platform fee rule administration",
  },
  {
    id: "86c-admin-blocked-payments",
    as: "ops",
    path: "/admin/payments",
    label: "DEC-0132 escape hatch: blocked payments and competitions",
  },
  {
    id: "87a-finance-disputes",
    as: "finOps",
    path: "/finance/payments",
    label: "finance_ops dispute list (read-only, cross-tenant)",
  },
  {
    id: "87b-finance-dispute-detail",
    as: "finOps",
    path: "/finance/payments/seed-pay-b",
    label: "finance_ops dispute detail with attempt history",
  },
  {
    id: "87-ops-on-candidate-surface",
    as: "ops",
    path: "/candidate-dashboard",
    label: "Operational account denied a participant surface",
  },
  {
    id: "88-ops-home",
    as: "ops",
    path: "/",
    label: "Landing page as operational account (nav withheld)",
  },

  // ---------------------------------------------------------------- MFA gate
  // Rendered by accounts deliberately left INSIDE the gate — `seed_ops_enrol` holds no factor and
  // `seed_ops_chal` holds one with no satisfied claim, so each lands on its own surface rather than
  // being redirected past it.
  {
    id: "90-mfa-enroll",
    as: "opsEnrol",
    path: "/auth/mfa/enroll",
    label: "MFA enrolment — QR, secret, recovery codes",
  },
  {
    id: "91-mfa-challenge",
    as: "opsChal",
    path: "/auth/mfa/challenge",
    label: "MFA challenge — code entry + recovery link",
  },
  {
    id: "92-mfa-gate-redirect",
    as: "opsEnrol",
    path: "/admin",
    label: "Guarded surface redirecting an un-enrolled operator",
  },

  // ---------------------------------------------------------------- password recovery
  // The reset page does not judge its token on load, so a placeholder renders the form itself.
  {
    id: "93-auth-forgot-password",
    as: null,
    path: "/auth/forgot-password",
    label: "Forgot password — request a reset link",
  },
  {
    id: "94-auth-reset-password",
    as: null,
    path: "/auth/reset-password?token=seed-placeholder-token",
    label: "Reset password — new password form",
  },
  {
    id: "95-auth-reset-password-no-token",
    as: null,
    path: "/auth/reset-password",
    label: "Reset password — link without a token",
  },
  {
    id: "96-auth-change-password",
    as: "candA",
    path: "/auth/change-password",
    label: "Change password — signed-in form",
  },
];

/*
 * The gallery's states on top of PAGES: the routes PAGES leaves out, every seeded status of a page
 * whose look depends on one, the empty states and the validation errors. Only gallery.mjs reads this
 * list, and only when GALLERY_WIDTHS is set. The contrast and mobile audits read PAGES alone, so
 * nothing here is measured by them.
 *
 * An entry id is the id prefix of its path, then its state, then `--` and its role key. A path that
 * PAGES lists takes the id of its first PAGES entry as its prefix. Every other path takes its number
 * from NEW_PATH_NUMBERS and its route part from the path itself.
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
  if (number === undefined) throw new Error(`pages.mjs: no id number for ${path}`);
  return `${number}-${routePartOf(path)}`;
};

const isInPages = (path, as) => PAGES.some((page) => page.path === path && page.as === as);

const entryFor = (path, as, state, interact) => {
  const stem = state ? `${idPrefixOf(path)}-${state}` : idPrefixOf(path);
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

const clearThenPressActionBar = (fieldSelectors, buttonName) => async (page) => {
  for (const selector of fieldSelectors) {
    await page.fill(selector, "");
  }
  await page
    .locator(".form-action-bar-end")
    .getByRole("button", { name: buttonName, exact: true })
    .click();
};

const clearLabelledFieldsThenPressActionBar = (labels, buttonName) => async (page) => {
  for (const label of labels) {
    await page
      .locator("label.form-field")
      .filter({ has: page.locator("span.form-label", { hasText: new RegExp(`^${label}$`) }) })
      .locator("input, textarea")
      .fill("");
  }
  await page
    .locator(".form-action-bar-end")
    .getByRole("button", { name: buttonName, exact: true })
    .click();
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
  validationErrorEntry(
    "/auth/verify-role?as=recruiter",
    "candA",
    clickControl('[data-testid="verify-role-recruiter"]'),
  ),
  validationErrorEntry(
    "/auth/verify-role?as=candidate",
    "recMin",
    clickControl('[data-testid="verify-role-candidate"]'),
  ),
  validationErrorEntry(
    "/institution/create",
    "recElev",
    clearThenPressActionBar([], "Buat institusi"),
  ),
  validationErrorEntry(
    "/institution/seed-academy/competitions/new",
    "recElev",
    clearThenPressActionBar([], "Lanjut"),
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
  validationErrorEntry(
    "/recruiter-dashboard",
    "recDraft",
    clearThenSubmitFormOf(["#rv-full-name", "#rv-mobile"]),
  ),
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
