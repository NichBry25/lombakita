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
    path: "/institution/seed-academy/competitions/seed-paid/edit",
    label: "Competition editor — paid, with fee disclosure",
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
];
