export const BASE = process.env.BASE_URL ?? "http://localhost:3000";
export const PASSWORD = "UjiCoba123!";

export const USERS = {
  candA: { id: "seed-user-cand-a", email: "seed.cand.a@seed.lombakita.local", username: "seed_cand_a" },
  candB: { id: "seed-user-cand-b", email: "seed.cand.b@seed.lombakita.local", username: "seed_cand_b" },
  candC: { id: "seed-user-cand-c", email: "seed.cand.c@seed.lombakita.local", username: "seed_cand_c" },
  recMin: { id: "seed-user-rec-min", email: "seed.rec.min@seed.lombakita.local", username: "seed_rec_min" },
  recElev: { id: "seed-user-rec-elev", email: "seed.rec.elev@seed.lombakita.local", username: "seed_rec_elev" },
  recRej: { id: "seed-user-rec-rej", email: "seed.rec.rej@seed.lombakita.local", username: "seed_rec_rej" },
  recDraft: { id: "seed-user-rec-draft", email: "seed.rec.draft@seed.lombakita.local", username: "seed_rec_draft" },
  dual: { id: "seed-user-dual", email: "seed.dual@seed.lombakita.local", username: "seed_dual" },
  ops: { id: "seed-user-ops", email: "seed.ops@seed.lombakita.local", username: "seed_ops" },
  susp: { id: "seed-user-susp", email: "seed.susp@seed.lombakita.local", username: "seed_susp" },
  unver: { id: "seed-user-unver", email: "seed.unver@seed.lombakita.local", username: "seed_unver" },
};

export const INST = {
  a: { id: "seed-inst-a", slug: "seed-academy" },
  b: { id: "seed-inst-b", slug: "seed-ventures" },
  c: { id: "seed-inst-c", slug: "seed-suspended-org" },
  p: { id: "seed-inst-p", slug: "seed-rec-min" },
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
