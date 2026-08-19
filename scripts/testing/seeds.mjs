export const BASE = process.env.BASE_URL ?? "http://localhost:3000";
export const PASSWORD = "UjiCoba123!";

// The TOTP secret behind every seeded MFA factor. Fixed and shared so the harness can generate a
// valid code without reading it back out of the database (it is stored encrypted), and so a human
// running the stage-9 checklist can add ONE authenticator entry and use it for every seeded
// operational account. Never a real secret — it exists only in seed data.
export const MFA_FACTOR_SECRET_HEX = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";

// `mfa` records which of the three operational states the account is seeded into. The harness reads
// it to decide whether a minted session must also complete a challenge before it is usable:
//   null / absent  — self-service account, the gate does not apply
//   "enrolment"    — operational, NO factor          → every guarded surface sends it to /auth/mfa/enroll
//   "challenge"    — operational, factor but no claim → every guarded surface sends it to /auth/mfa/challenge
//   "satisfied"    — operational, factor AND the harness elevates the session after signing in
export const USERS = {
  candA: { id: "seed-user-cand-a", email: "seed.cand.a@seed.lombakita.local", username: "seed_cand_a" },
  candB: { id: "seed-user-cand-b", email: "seed.cand.b@seed.lombakita.local", username: "seed_cand_b" },
  candC: { id: "seed-user-cand-c", email: "seed.cand.c@seed.lombakita.local", username: "seed_cand_c" },
  recMin: { id: "seed-user-rec-min", email: "seed.rec.min@seed.lombakita.local", username: "seed_rec_min" },
  recElev: { id: "seed-user-rec-elev", email: "seed.rec.elev@seed.lombakita.local", username: "seed_rec_elev" },
  recRej: { id: "seed-user-rec-rej", email: "seed.rec.rej@seed.lombakita.local", username: "seed_rec_rej" },
  recDraft: { id: "seed-user-rec-draft", email: "seed.rec.draft@seed.lombakita.local", username: "seed_rec_draft" },
  dual: { id: "seed-user-dual", email: "seed.dual@seed.lombakita.local", username: "seed_dual" },
  ops: { id: "seed-user-ops", email: "seed.ops@seed.lombakita.local", username: "seed_ops", mfa: "satisfied" },
  opsEnrol: { id: "seed-user-ops-enrol", email: "seed.ops.enrol@seed.lombakita.local", username: "seed_ops_enrol", mfa: "enrolment" },
  opsChal: { id: "seed-user-ops-chal", email: "seed.ops.chal@seed.lombakita.local", username: "seed_ops_chal", mfa: "challenge" },
  susp: { id: "seed-user-susp", email: "seed.susp@seed.lombakita.local", username: "seed_susp" },
  unver: { id: "seed-user-unver", email: "seed.unver@seed.lombakita.local", username: "seed_unver" },
};

export const INST = {
  a: { id: "seed-inst-a", slug: "seed-academy" },
  b: { id: "seed-inst-b", slug: "seed-ventures" },
  c: { id: "seed-inst-c", slug: "seed-suspended-org" },
  p: { id: "seed-inst-p", slug: "seed-rec-min" },
  // The SECOND verified tenant, and the only one that can express a cross-tenant violation. `a` and
  // `b` cannot: `rec-elev` administers both, so "an outsider reaching into another institution" has
  // no outsider. `d` is owned by `rec-min`, who administers nothing at `a`.
  d: { id: "seed-inst-d", slug: "seed-kolektif" },
};

export const COMP = {
  draft: { id: "seed-comp-draft", slug: "seed-draft" },
  upcoming: { id: "seed-comp-upcoming", slug: "seed-upcoming" },
  open: { id: "seed-comp-open", slug: "seed-open" },
  featured: { id: "seed-comp-featured", slug: "seed-featured" },
  closing: { id: "seed-comp-closing", slug: "seed-closing" },
  closed: { id: "seed-comp-closed", slug: "seed-closed" },
  inprogress: { id: "seed-comp-inprogress", slug: "seed-inprogress" },
  awaiting: { id: "seed-comp-awaiting", slug: "seed-awaiting" },
  overdue: { id: "seed-comp-overdue", slug: "seed-overdue" },
  done: { id: "seed-comp-done", slug: "seed-done" },
  // Deliberately kept free of registrations: it is the stage the team lifecycle assertions build
  // on (create → invite → accept → register → cancel → delete). Every other team-capable
  // competition already has both free candidates registered, so the happy path has nowhere to run.
  teamOpen: { id: "seed-comp-teamopen", slug: "seed-team-open" },
  personalOpen: { id: "seed-comp-personal-open", slug: "seed-personal-open" },
  personalDraft: { id: "seed-comp-personal-draft", slug: "seed-personal-draft" },
  susp: { id: "seed-comp-susp", slug: "seed-susp-open" },
  bDraft: { id: "seed-comp-b-draft", slug: "seed-b-draft" },
  paid: { id: "seed-comp-paid", slug: "seed-paid" },
  dPaid: { id: "seed-comp-d-paid", slug: "seed-kolektif-paid" },
};

export const REG = {
  aOpen: "seed-reg-a-open",
  cOpen: "seed-reg-c-open",
  aFeatCxl: "seed-reg-a-feat-cxl",
  aInprog: "seed-reg-a-inprog",
  aDone: "seed-reg-a-done",
  bDone: "seed-reg-b-done",
  tbB: "seed-reg-tb-b",
  tbC: "seed-reg-tb-c",
};
