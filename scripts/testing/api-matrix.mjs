/**
 * API guard & behavior matrix — terminal-only assertions (no UI). Covers auth branches,
 * role gates, ownership/IDOR collapses, Rule-16 session-mismatch, publish gates, ops guards.
 * Writes test-artifacts/behavior/api-matrix.{json,md} in the repo.
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { cookieHeader, elevateMfaSession, mintSession, apiFetch } from "./lib-auth.mjs";
import { bodyHasValue, bodySnippet, errorCode, refusedWith } from "./lib-assertions.mjs";
import { USERS, INST, COMP, REG } from "./seeds.mjs";

// Resolved from this file's own location, not hard-coded to one laptop's home directory: the
// artifacts have to land in the repository the script is running in, wherever that is.
const REPO = resolve(new URL("../..", import.meta.url).pathname);
const results = [];

const record = (id, name, expected, actual, pass, note = "") => {
  results.push({ id, name, expected, actual, pass, note });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${id}  ${name}  [expected ${expected} | got ${actual}]${note ? "  — " + note : ""}`,
  );
};

const main = async () => {
  // ---- sessions -----------------------------------------------------------
  const sessions = {};
  const sessionKeys = [
    "candA",
    "candB",
    "candC",
    "recMin",
    "recElev",
    "recRej",
    "recDraft",
    "dual",
    "ops",
    "finOps",
  ];
  for (const key of sessionKeys) {
    const s = await mintSession(USERS[key].email);
    if (!s.ok) throw new Error(`Could not mint session for ${key}: ${s.error}`);

    // OPERATIONAL SESSIONS MUST BE ELEVATED, or every operator case measures the MFA gate instead
    // of the thing it names. A minted platform_ops session is `challenge_required`, and
    // `requireSessionRole` answers 403 with `mfa_challenge_required`, the SAME status a role
    // refusal produces, so a negative case reads as passing while a positive case reads as a
    // product defect. `lib-browser` has elevated its contexts since Step 7.1; this harness never
    // did, which is why every OPS/MOD/VERIF/FEAT operator case has been red or falsely green since.
    if (USERS[key].mfa === "satisfied") {
      await elevateMfaSession(s.jar);
      sessions[key] = cookieHeader(s.jar);
    } else {
      sessions[key] = s.cookie;
    }
  }
  record(
    "AUTH-01",
    "Login succeeds for all seeded active accounts",
    `${sessionKeys.length} sessions`,
    `${Object.keys(sessions).length} sessions`,
    Object.keys(sessions).length === sessionKeys.length,
  );

  // ---- auth negative branches --------------------------------------------
  const wrongPw = await mintSession(USERS.candA.email, "SalahTotal999!");
  record(
    "AUTH-02",
    "Wrong password rejected",
    "error, no session",
    wrongPw.ok ? "session!" : String(wrongPw.error),
    !wrongPw.ok,
  );

  const susp = await mintSession(USERS.susp.email);
  record(
    "AUTH-03",
    "Suspended account blocked at login (ACCOUNT_SUSPENDED)",
    "ACCOUNT_SUSPENDED",
    String(susp.error),
    !susp.ok && susp.error === "ACCOUNT_SUSPENDED",
  );

  const unver = await mintSession(USERS.unver.email);
  record(
    "AUTH-04",
    "Unverified email blocked at login (EMAIL_NOT_VERIFIED)",
    "EMAIL_NOT_VERIFIED",
    String(unver.error),
    !unver.ok && unver.error === "EMAIL_NOT_VERIFIED",
  );

  // identify classification
  for (const [id, email, want] of [
    ["AUTH-05", USERS.candA.email, "verified"],
    ["AUTH-06", USERS.unver.email, "unverified"],
    ["AUTH-07", "tidak.ada@seed.lombakita.local", "none"],
  ]) {
    const r = await apiFetch("/api/v1/auth/identify", { method: "POST", json: { email } });
    const got = JSON.stringify(r.body);
    record(
      id,
      `identify(${email.split("@")[0]}) classifies '${want}'`,
      want,
      got.slice(0, 60),
      r.status === 200 && r.body?.state === want,
    );
  }

  // ---- public reads -------------------------------------------------------
  const health = await apiFetch("/api/health");
  // Whether the presigner can answer at all. Read once, so the finance-lane cases below can pin a
  // single expected status instead of accepting either and calling an outage a pass.
  const storageExpectation = health.body?.checks?.r2 === "ok" ? 200 : 503;
  record(
    "PUB-01",
    "GET /api/health all-ok",
    "200 ok",
    `${health.status} ${health.body?.status}`,
    health.status === 200 && health.body?.status === "ok",
  );

  const list = await apiFetch("/api/v1/competitions");
  // MATCHED ON THE SLUG FIELD, not on the serialised body. `"seed-open"` is a substring of
  // `"seed-open-archive"` and of any longer slug that starts the same way, so a needle search
  // cannot tell one competition from another whose name merely begins with it.
  const listedSlugs = (list.body?.data ?? []).map((c) => c.slug);
  record(
    "PUB-02",
    "Public listing shows open comps, hides drafts",
    "seed-open ∧ ¬seed-draft",
    `${list.status} ${listedSlugs.length} listed`,
    list.status === 200 &&
      listedSlugs.includes(COMP.open.slug) &&
      !listedSlugs.includes(COMP.draft.slug),
  );
  record(
    "PUB-03",
    "Default listing hides finished comps",
    "¬seed-done",
    listedSlugs.includes(COMP.done.slug) ? "shown" : "hidden",
    !listedSlugs.includes(COMP.done.slug),
  );

  const listAll = await apiFetch("/api/v1/competitions?status=all");
  const listAllSlugs = (listAll.body?.data ?? []).map((c) => c.slug);
  record(
    "PUB-04",
    "status=all includes finished comps",
    "seed-done present",
    listAllSlugs.includes(COMP.done.slug) ? "present" : "absent",
    listAll.status === 200 && listAllSlugs.includes(COMP.done.slug),
  );

  const detail = await apiFetch(`/api/v1/competitions/public/${INST.a.slug}/${COMP.open.slug}`);
  // "Seed Hackathon" is a PREFIX of the seeded title, not the title. The needle search passed on
  // it for the life of this case, which is the D32 defect in one line: a longer string containing
  // the needle satisfies the assertion while meaning something else.
  record(
    "PUB-05",
    "Public detail of published comp",
    "200 Seed Hackathon Nusantara",
    `${detail.status} ${detail.body?.competition?.title}`,
    detail.status === 200 && detail.body?.competition?.title === "Seed Hackathon Nusantara",
  );

  const draftDetail = await apiFetch(
    `/api/v1/competitions/public/${INST.a.slug}/${COMP.draft.slug}`,
  );
  record(
    "PUB-06",
    "Public detail of DRAFT comp is 404",
    "404",
    `${draftDetail.status}`,
    draftDetail.status === 404,
  );

  const personalDetail = await apiFetch(
    `/api/v1/competitions/public/${INST.p.slug}/${COMP.personalOpen.slug}`,
  );
  record(
    "PUB-07",
    "Personal-institution comp public detail (derived organizer)",
    "200",
    `${personalDetail.status}`,
    personalDetail.status === 200,
    bodySnippet(personalDetail.body).slice(0, 80),
  );

  // A suspended institution has no public footprint: its own page is withheld and its
  // competitions go with it, in discovery and on the detail page alike.
  const suspDetail = await apiFetch(`/api/v1/competitions/public/${INST.c.slug}/${COMP.susp.slug}`);
  record(
    "PUB-08",
    "Suspended-org comp public detail is withheld",
    "404",
    `${suspDetail.status}`,
    suspDetail.status === 404,
  );

  const allListing = await apiFetch("/api/v1/competitions?status=all&limit=100");
  const allSlugs = (allListing.body?.data ?? []).map((c) => c.slug);
  record(
    "PUB-09",
    "Suspended-org comp absent from listing (status=all spans every phase)",
    "absent",
    allSlugs.includes(COMP.susp.slug) ? "present" : "absent",
    !allSlugs.includes(COMP.susp.slug),
    `${allSlugs.length} competitions listed`,
  );

  // ---- candidate-owned reads ---------------------------------------------
  const anonInbox = await apiFetch("/api/v1/me/inbox");
  record("CAND-01", "Inbox requires auth", "401", `${anonInbox.status}`, anonInbox.status === 401);

  const inbox = await apiFetch("/api/v1/me/inbox", { cookie: sessions.candA });
  record(
    "CAND-02",
    "cand.a inbox lists seeded notifications",
    "200 + items",
    `${inbox.status}`,
    inbox.status === 200 && bodyHasValue(inbox.body, "Hasil kompetisi diumumkan"),
  );

  // Inbox count spans notifications AND pending invitations: 2 unread notifs + 1 pending team invite.
  const unread = await apiFetch("/api/v1/me/inbox/unread-count", { cookie: sessions.candA });
  record(
    "CAND-03",
    "Unread count = 3 (2 notifs + 1 pending invite)",
    "3",
    bodySnippet(unread.body),
    unread.status === 200 && unread.body?.unreadCount === 3,
  );

  const saved = await apiFetch("/api/v1/me/saved-competitions", { cookie: sessions.candA });
  const savedSlugs = (saved.body?.data ?? []).map((c) => c.slug);
  record(
    "CAND-04",
    "Saved list has 3 seeded saves",
    "3 slugs",
    `${saved.status} ${savedSlugs.length} saved`,
    saved.status === 200 &&
      [COMP.open.slug, COMP.upcoming.slug, COMP.done.slug].every((slug) =>
        savedSlugs.includes(slug),
      ),
  );

  const candProf = await apiFetch("/api/v1/candidate/me/profile", { cookie: sessions.candA });
  record(
    "CAND-05",
    "Candidate onboarding profile readable by owner",
    "200 Andi Saputra",
    `${candProf.status}`,
    candProf.status === 200 && bodyHasValue(candProf.body, "Andi Saputra"),
  );

  const candProfAsRec = await apiFetch("/api/v1/candidate/me/profile", { cookie: sessions.recMin });
  record(
    "CAND-06",
    "Candidate profile refused for recruiter-only account",
    "403",
    `${candProfAsRec.status}`,
    candProfAsRec.status === 403,
  );

  const docReqs = await apiFetch("/api/v1/me/document-requests", { cookie: sessions.candA });
  record(
    "CAND-07",
    "Candidate sees own document requests",
    "200 + Kartu Pelajar / KTM",
    `${docReqs.status}`,
    docReqs.status === 200 && bodyHasValue(docReqs.body, "Kartu Pelajar / KTM"),
  );

  const resultOwn = await apiFetch(
    `/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.aDone}/result`,
    { cookie: sessions.candA },
  );
  record(
    "CAND-08",
    "Published result visible to owner (Juara 1)",
    "200 Juara 1",
    `${resultOwn.status}`,
    resultOwn.status === 200 && bodyHasValue(resultOwn.body, "Juara 1"),
  );

  const resultForeign = await apiFetch(
    `/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`,
    { cookie: sessions.candA },
  );
  record(
    "CAND-09",
    "Foreign registration result IDOR collapses",
    "404",
    `${resultForeign.status}`,
    resultForeign.status === 404,
  );

  const resultDraft = await apiFetch(
    `/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`,
    { cookie: sessions.candB },
  );
  // PINNED TO 404. The disjunction accepted "some other status, with no Juara 2 in the body",
  // which a 500 satisfies — an error page carries no award title either.
  record(
    "CAND-10",
    "DRAFT result not visible to its own candidate",
    "404",
    `${resultDraft.status}`,
    resultDraft.status === 404 && !bodyHasValue(resultDraft.body, "Juara 2"),
    bodySnippet(resultDraft.body).slice(0, 80),
  );

  // Rule 16 session-mismatch guard
  const mismatch = await apiFetch("/api/v1/candidate/me/profile", {
    method: "PATCH",
    cookie: sessions.candA,
    headers: { "X-Expected-User-Id": USERS.candB.id },
    json: { fullName: "X", phoneNumber: "+62812", occupation: "other", dateOfBirth: "2000-01-01" },
  });
  record(
    "CAND-11",
    "Rule-16 session mismatch → 409",
    "409",
    `${mismatch.status}`,
    mismatch.status === 409,
    bodySnippet(mismatch.body).slice(0, 80),
  );

  // save / unsave round-trip on a comp not seeded as saved
  const saveRes = await apiFetch(`/api/v1/competitions/${COMP.closing.id}/save`, {
    method: "POST",
    cookie: sessions.candA,
    headers: { "X-Expected-User-Id": USERS.candA.id },
  });
  const unsaveRes = await apiFetch(`/api/v1/competitions/${COMP.closing.id}/save`, {
    method: "DELETE",
    cookie: sessions.candA,
    headers: { "X-Expected-User-Id": USERS.candA.id },
  });
  record(
    "CAND-12",
    "Save then unsave round-trip",
    "200,200",
    `${saveRes.status},${unsaveRes.status}`,
    saveRes.status === 200 && unsaveRes.status === 200,
  );

  // registration refusals
  const regClosed = await apiFetch(`/api/v1/competitions/${COMP.closed.id}/registrations`, {
    method: "POST",
    cookie: sessions.candB,
    headers: { "X-Expected-User-Id": USERS.candB.id },
    json: {},
  });
  record(
    "CAND-13",
    "Register after deadline refused (code registration_deadline_passed)",
    "409 registration_deadline_passed",
    `${regClosed.status} ${errorCode(regClosed)}`,
    refusedWith(regClosed, 409, "registration_deadline_passed"),
    "HTTP 409 — uat-script.md claims 400 (doc drift)",
  );

  const regDup = await apiFetch(`/api/v1/competitions/${COMP.open.id}/registrations`, {
    method: "POST",
    cookie: sessions.candA,
    headers: { "X-Expected-User-Id": USERS.candA.id },
    json: {},
  });
  record(
    "CAND-14",
    "Duplicate registration refused (already registered)",
    "409 registration_already_exists",
    `${regDup.status} ${errorCode(regDup)}`,
    refusedWith(regDup, 409, "registration_already_exists"),
    bodySnippet(regDup.body).slice(0, 100),
  );

  // cancellation policy gates
  const cxlNotAllowed = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}`,
    {
      method: "DELETE",
      cookie: sessions.candA,
      headers: { "X-Expected-User-Id": USERS.candA.id },
      json: { cancellationReason: "Uji pembatalan otomatis." },
    },
  );
  // THE FIELD NAME IS THE FIX, not the assertion. This sent `reason`, which the cancel route's
  // parser rejects as an unsupported key — so for four steps the case was measuring payload
  // validation and reporting it as the cancellation-policy gate, and the 4xx range could not see
  // the difference. Pinning the code is what makes the two distinguishable.
  record(
    "CAND-15",
    "Cancel refused when allow_cancellation=false",
    "422 cancellation_disabled_by_institution",
    `${cxlNotAllowed.status} ${errorCode(cxlNotAllowed)}`,
    refusedWith(cxlNotAllowed, 422, "cancellation_disabled_by_institution"),
    bodySnippet(cxlNotAllowed.body).slice(0, 100),
  );

  // ---- recruiter / institution scoping ------------------------------------
  const rvOwn = await apiFetch("/api/v1/recruiter/me/verification", { cookie: sessions.recMin });
  record(
    "REC-01",
    "Recruiter sees own verification submission",
    "200 pending_review",
    `${rvOwn.status} ${rvOwn.body?.verification?.submission?.status}`,
    rvOwn.status === 200 && rvOwn.body?.verification?.submission?.status === "pending_review",
  );

  const rvAsCand = await apiFetch("/api/v1/recruiter/me/verification", { cookie: sessions.candA });
  record(
    "REC-02",
    "Recruiter verification refused for candidate",
    "403",
    `${rvAsCand.status}`,
    rvAsCand.status === 403,
  );

  const compListOwner = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, {
    cookie: sessions.recElev,
  });
  const ownerListedSlugs = (compListOwner.body?.competitions ?? []).map((c) => c.slug);
  record(
    "INST-01",
    "Owner lists institution competitions",
    "200 + seed-open",
    `${compListOwner.status} ${ownerListedSlugs.length} listed`,
    compListOwner.status === 200 && ownerListedSlugs.includes(COMP.open.slug),
  );

  const compListStaff = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, {
    cookie: sessions.dual,
  });
  record(
    "INST-02",
    "Staff (dual) lists institution competitions",
    "200",
    `${compListStaff.status}`,
    compListStaff.status === 200,
  );

  const compListOutsider = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, {
    cookie: sessions.recMin,
  });
  record(
    "INST-03",
    "Non-member recruiter refused",
    "403",
    `${compListOutsider.status} ${errorCode(compListOutsider)}`,
    compListOutsider.status === 403,
  );

  const compListCand = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, {
    cookie: sessions.candA,
  });
  record(
    "INST-04",
    "Candidate refused on institution surface",
    "403",
    `${compListCand.status} ${errorCode(compListCand)}`,
    compListCand.status === 403,
  );

  const participants = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.open.id}/participants`,
    { cookie: sessions.recElev },
  );
  record(
    "INST-05",
    "Participants console lists registrants",
    "200 + names",
    `${participants.status}`,
    participants.status === 200 && bodyHasValue(participants.body, USERS.candA.username),
    bodySnippet(participants.body).slice(0, 80),
  );

  // Institution-scoped participants: a foreign competition id yields an EMPTY result set rather
  // than 404. The assertion is that no foreign data crosses.
  const crossTenant = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.open.id}/participants`,
    { cookie: sessions.recElev },
  );
  // PINNED TO THE ANSWER THE ROUTE GIVES: 200 with an empty set. The disjunction also accepted a
  // 404, so whichever of the two shapes the route moved to, the case reported a clean isolation
  // boundary — including if it had stopped answering at all.
  record(
    "INST-06",
    "Cross-institution participants leak nothing (empty set)",
    "200, 0 participants",
    `${crossTenant.status} count=${crossTenant.body?.counts?.total}`,
    crossTenant.status === 200 &&
      crossTenant.body?.counts?.total === 0 &&
      !bodyHasValue(crossTenant.body, USERS.candA.username),
  );

  const crossTenantOutsider = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.open.id}/participants`,
    { cookie: sessions.recMin },
  );
  record(
    "INST-06b",
    "Outsider recruiter refused on another institution's participants",
    "403",
    `${crossTenantOutsider.status} ${errorCode(crossTenantOutsider)}`,
    crossTenantOutsider.status === 403,
  );

  const exportCsv = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/export/registrants`,
    { cookie: sessions.recElev },
  );
  record(
    "INST-07",
    "Registrants CSV export",
    "200 text/csv",
    `${exportCsv.status} ${exportCsv.contentType.split(";")[0]}`,
    exportCsv.status === 200 && exportCsv.contentType.split(";")[0].trim() === "text/csv",
  );

  const auditLog = await apiFetch(`/api/v1/institutions/${INST.a.slug}/audit-log`, {
    cookie: sessions.recElev,
  });
  record(
    "INST-08",
    "Audit log readable by owner",
    "200",
    `${auditLog.status}`,
    auditLog.status === 200,
  );

  const orgSubmissionFile = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`,
    { cookie: sessions.recElev },
  );
  // The signature is a QUERY PARAMETER, so it is asked for as one. A substring search over the URL
  // is also satisfied by the string appearing in a path segment or an unrelated parameter's value.
  const signedParams = new URL(orgSubmissionFile.body?.url ?? "http://absent.invalid").searchParams;
  record(
    "INST-09",
    "Organizer gets presigned submission URL (audited read)",
    "200 + R2 signed url",
    `${orgSubmissionFile.status} signature=${signedParams.has("X-Amz-Signature")}`,
    orgSubmissionFile.status === 200 && signedParams.has("X-Amz-Signature"),
  );

  const orgSubmissionForeign = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`,
    { cookie: sessions.recElev },
  );
  record(
    "INST-10",
    "Submission file via wrong institution scope collapses",
    "404",
    `${orgSubmissionForeign.status}`,
    orgSubmissionForeign.status === 404,
  );

  const orgSubmissionAsCand = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`,
    { cookie: sessions.candA },
  );
  record(
    "INST-11",
    "Candidate refused on organizer submission-file route",
    "403",
    `${orgSubmissionAsCand.status} ${errorCode(orgSubmissionAsCand)}`,
    orgSubmissionAsCand.status === 403,
  );

  // publish gates
  const publishMinimal = await apiFetch(
    `/api/v1/institutions/${INST.p.slug}/competitions/${COMP.personalDraft.id}/publish`,
    {
      method: "POST",
      cookie: sessions.recMin,
      json: {},
    },
  );
  record(
    "GATE-01",
    "Publish refused for minimal-tier recruiter (Trusted gate)",
    "403",
    `${publishMinimal.status}`,
    publishMinimal.status === 403,
    bodySnippet(publishMinimal.body).slice(0, 100),
  );

  const publishElev = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: {},
    },
  );
  record(
    "GATE-02",
    "Publish succeeds for elevated recruiter (complete draft)",
    "200",
    `${publishElev.status}`,
    publishElev.status === 200,
    bodySnippet(publishElev.body).slice(0, 100),
  );

  const unpublishElev = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/unpublish`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: {},
    },
  );
  record(
    "GATE-03",
    "Unpublish returns to draft (state restored, 0 registrations)",
    "200",
    `${unpublishElev.status}`,
    unpublishElev.status === 200,
  );

  // immutable-after-publish on a published comp with registrations
  const immutable = await apiFetch(`/api/v1/competitions/${COMP.open.id}`, {
    method: "PATCH",
    cookie: sessions.recElev,
    json: { mode: "individual" },
  });
  record(
    "GATE-04",
    "Post-publish mode change refused (immutable field)",
    "422",
    `${immutable.status}`,
    immutable.status === 422,
    bodySnippet(immutable.body).slice(0, 100),
  );

  // ---- platform ops --------------------------------------------------------
  const opsQueue = await apiFetch("/api/platform-ops/recruiter-verification/pending", {
    cookie: sessions.ops,
  });
  // FULL NAMES, matched whole. "Rina" is a substring of any name containing it, and "Dodi" —
  // the one that must be ABSENT — would report a leak from any unrelated field that happened to
  // contain those four letters.
  const queueHasApplicant = (name) => bodyHasValue(opsQueue.body, name);
  record(
    "OPS-01",
    "Recruiter verification queue (pending + rejected visible)",
    "200 + Rina Wijaya + Raka Nugraha",
    `${opsQueue.status}`,
    opsQueue.status === 200 &&
      queueHasApplicant("Rina Wijaya") &&
      queueHasApplicant("Raka Nugraha"),
  );
  record(
    "OPS-02",
    "Withdrawn draft invisible to ops queue",
    "no Dodi Firmansyah",
    queueHasApplicant("Dodi Firmansyah") ? "Dodi visible" : "hidden",
    !queueHasApplicant("Dodi Firmansyah"),
  );

  const opsQueueAsRec = await apiFetch("/api/platform-ops/recruiter-verification/pending", {
    cookie: sessions.recElev,
  });
  record(
    "OPS-03",
    "Ops queue refused for recruiter",
    "403",
    `${opsQueueAsRec.status}`,
    opsQueueAsRec.status === 403,
  );

  const instVerifQueue = await apiFetch("/api/platform-ops/verification/pending", {
    cookie: sessions.ops,
  });
  record(
    "OPS-04",
    "Institution verification queue shows Seed Ventures",
    "200 + Seed Ventures",
    `${instVerifQueue.status}`,
    instVerifQueue.status === 200 && bodyHasValue(instVerifQueue.body, "Seed Ventures"),
  );

  const adminInst = await apiFetch("/api/admin/institutions", { cookie: sessions.ops });
  record(
    "OPS-05",
    "Admin institutions list for ops",
    "200",
    `${adminInst.status}`,
    adminInst.status === 200,
  );
  const adminInstAnon = await apiFetch("/api/admin/institutions");
  record(
    "OPS-06",
    "Admin institutions refused anon",
    "401",
    `${adminInstAnon.status} ${errorCode(adminInstAnon)}`,
    adminInstAnon.status === 401,
  );

  const verifyRoleOps = await apiFetch("/api/v1/auth/verify-role", {
    method: "POST",
    cookie: sessions.ops,
    json: { role: "recruiter" },
  });
  record(
    "OPS-07",
    "Operational account cannot self-verify participant role",
    "403",
    `${verifyRoleOps.status}`,
    verifyRoleOps.status === 403,
    bodySnippet(verifyRoleOps.body).slice(0, 80),
  );

  // Profile fields are parsed FLAT off the body (not nested under candidateProfile).
  const verifyRoleDup = await apiFetch("/api/v1/auth/verify-role", {
    method: "POST",
    cookie: sessions.candA,
    json: {
      role: "candidate",
      fullName: "Andi Saputra",
      phoneNumber: "+6281200000001",
      occupation: "college_student",
      dateOfBirth: "2004-05-14",
    },
  });
  record(
    "OPS-08",
    "Already-verified role returns 409",
    "409",
    `${verifyRoleDup.status}`,
    verifyRoleDup.status === 409,
    bodySnippet(verifyRoleDup.body).slice(0, 90),
  );

  // A recruiter-only account, so the request gets past the already-verified gate and reaches
  // profile parsing. Sending candA here would 409 (OPS-08) and prove nothing about the payload.
  // The empty payload is refused before any grant, so this assertion does not mutate the seed.
  const verifyRoleNoProfile = await apiFetch("/api/v1/auth/verify-role", {
    method: "POST",
    cookie: sessions.recElev,
    json: { role: "candidate" },
  });
  record(
    "OPS-09",
    "Candidate verify-role without profile payload refused",
    "400 candidate_profile_*",
    `${verifyRoleNoProfile.status}`,
    verifyRoleNoProfile.status === 400,
    bodySnippet(verifyRoleNoProfile.body).slice(0, 90),
  );

  // The two orderings are distinguishable only when BOTH would fail: an account that already
  // holds the role, sending no payload. The caller must be told the role is already held.
  const verifyRoleDupNoProfile = await apiFetch("/api/v1/auth/verify-role", {
    method: "POST",
    cookie: sessions.candA,
    json: { role: "candidate" },
  });
  record(
    "OPS-10",
    "Already-verified role answered before payload validation",
    "409 role_already_verified",
    `${verifyRoleDupNoProfile.status} ${verifyRoleDupNoProfile.body?.error?.code ?? ""}`.trim(),
    verifyRoleDupNoProfile.status === 409 &&
      verifyRoleDupNoProfile.body?.error?.code === "role_already_verified",
  );

  // ---- publish checklist (distinct from the tier gate above) ----------------
  // GATE-01 proves an under-tier recruiter is refused before the checklist runs. This is the other
  // half: a Trusted recruiter, an incomplete draft, and a refusal that names what is missing.
  const publishIncomplete = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.draft.id}/publish`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: {},
    },
  );
  record(
    "GATE-05",
    "Publish refused for incomplete draft, missing fields named",
    "422 + field list",
    `${publishIncomplete.status}`,
    publishIncomplete.status === 422 && JSON.stringify(publishIncomplete.body).length > 40,
    bodySnippet(publishIncomplete.body).slice(0, 110),
  );

  // ---- result lifecycle: upsert -> publish -> unpublish -> restore ----------
  // Every assertion above reads results the seed wrote. This drives the organizer's write path and
  // puts the row back exactly as seeded, so the suite stays re-runnable.
  const resultPath = `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`;
  const candBResultPath = `/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`;

  const resultUpsert = await apiFetch(resultPath, {
    method: "PUT",
    cookie: sessions.recElev,
    json: { resultLabel: "Juara 2", resultNotes: "Draf internal — disunting oleh uji otomatis." },
  });
  record(
    "RES-01",
    "Organizer upserts a result draft",
    "200",
    `${resultUpsert.status}`,
    resultUpsert.status === 200,
    bodySnippet(resultUpsert.body).slice(0, 80),
  );

  const resultPublish = await apiFetch(`${resultPath}/publish`, {
    method: "POST",
    cookie: sessions.recElev,
    json: {},
  });
  record(
    "RES-02",
    "Organizer publishes the result",
    "200",
    `${resultPublish.status}`,
    resultPublish.status === 200,
    bodySnippet(resultPublish.body).slice(0, 80),
  );

  const resultNowVisible = await apiFetch(candBResultPath, { cookie: sessions.candB });
  record(
    "RES-03",
    "Published result becomes visible to its own candidate",
    "200 + Juara 2",
    `${resultNowVisible.status}`,
    resultNowVisible.status === 200 && bodyHasValue(resultNowVisible.body, "Juara 2"),
  );

  const resultUnpublish = await apiFetch(`${resultPath}/unpublish`, {
    method: "POST",
    cookie: sessions.recElev,
    json: {},
  });
  record(
    "RES-04",
    "Organizer unpublishes the result",
    "200",
    `${resultUnpublish.status}`,
    resultUnpublish.status === 200,
  );

  const resultHiddenAgain = await apiFetch(candBResultPath, { cookie: sessions.candB });
  record(
    "RES-05",
    "Unpublished result collapses for the candidate again",
    "404",
    `${resultHiddenAgain.status}`,
    resultHiddenAgain.status === 404 && !bodyHasValue(resultHiddenAgain.body, "Juara 2"),
  );

  const resultRestore = await apiFetch(resultPath, {
    method: "PUT",
    cookie: sessions.recElev,
    json: { resultLabel: "Juara 2", resultNotes: "Draf internal — belum dipublikasikan." },
  });
  record(
    "RES-06",
    "Seeded draft result restored verbatim",
    "200",
    `${resultRestore.status}`,
    resultRestore.status === 200,
  );

  // ---- team lifecycle: create -> invite by username -> accept -> register ----
  // Runs on seed-comp-teamopen, the one team-capable competition kept free of registrations.
  // The name is unique per run because disbanding is SOFT: the row and its name survive, so a
  // fixed name collides with the previous run's team on the second pass.
  const teamName = `Tim Uji Otomatis ${Date.now()}`;
  const teamCreate = await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams`, {
    method: "POST",
    cookie: sessions.candB,
    headers: { "X-Expected-User-Id": USERS.candB.id },
    json: { name: teamName },
  });
  const teamId = teamCreate.body?.team?.id ?? teamCreate.body?.id ?? null;
  record(
    "TEAM-01",
    "Candidate creates a team on an open team competition",
    "2xx + team id",
    `${teamCreate.status} id=${teamId ?? "none"}`,
    teamCreate.status === 201 && Boolean(teamId),
    bodySnippet(teamCreate.body).slice(0, 90),
  );

  // A username invite must resolve to a real target rather than falling through to the
  // pending_claim (unknown-email) branch — that distinction is the whole point of DEC-6.5e.
  const teamInvite = teamId
    ? await apiFetch(`/api/v1/teams/${teamId}/invitations`, {
        method: "POST",
        cookie: sessions.candB,
        headers: { "X-Expected-User-Id": USERS.candB.id },
        json: { invitedIdentifier: USERS.candC.username },
      })
    : { status: 0, body: "skipped: no team id" };
  const teamInviteId = teamInvite.body?.invitation?.id ?? teamInvite.body?.id ?? null;
  const teamInviteEmail = teamInvite.body?.invitation?.invitedEmail ?? "(absent)";
  record(
    "TEAM-02",
    "Team invite by USERNAME resolves to the right account's email",
    `${USERS.candC.email}`,
    `${teamInvite.status} ${teamInviteEmail}`,
    teamInvite.status === 201 && teamInviteEmail === USERS.candC.email,
  );

  // The response carries no status field, so the targeted-vs-pending_claim branch is asserted where
  // it is actually observable: the inbox queries solely by target_user_id, so a pending_claim
  // invitation (null target) is invisible there by construction.
  const inviteeInbox = await apiFetch("/api/v1/me/inbox", { cookie: sessions.candC });
  record(
    "TEAM-02b",
    "Targeted invite reaches the invitee's inbox (target_user_id was set)",
    "team invite present",
    `${inviteeInbox.status}`,
    inviteeInbox.status === 200 && bodyHasValue(inviteeInbox.body, teamName),
    bodySnippet(inviteeInbox.body).slice(0, 90),
  );

  const teamAccept = teamInviteId
    ? await apiFetch(`/api/v1/me/invitations/team/${teamInviteId}/accept`, {
        method: "POST",
        cookie: sessions.candC,
        headers: { "X-Expected-User-Id": USERS.candC.id },
        json: {},
      })
    : { status: 0, body: "skipped: no invitation id" };
  record(
    "TEAM-03",
    "Invited candidate accepts and joins the roster",
    "2xx",
    `${teamAccept.status}`,
    teamAccept.status === 200,
    bodySnippet(teamAccept.body).slice(0, 90),
  );

  const teamRegister = teamId
    ? await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams/${teamId}/registrations`, {
        method: "POST",
        cookie: sessions.candB,
        headers: { "X-Expected-User-Id": USERS.candB.id },
        json: {},
      })
    : { status: 0, body: "skipped: no team id" };
  record(
    "TEAM-04",
    "Captain submits the team registration",
    "2xx",
    `${teamRegister.status}`,
    teamRegister.status === 201,
    bodySnippet(teamRegister.body).slice(0, 90),
  );

  const teamParticipants = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.teamOpen.id}/participants`,
    { cookie: sessions.recElev },
  );
  // `seed_cand_b` and `seed_cand_c` are each a prefix of nothing here, but `seed_cand_a` is a
  // prefix of neither and a needle search would still match any username that CONTAINS one.
  record(
    "TEAM-05",
    "Both team members appear to the organizer as registrants",
    "candB ∧ candC",
    `${teamParticipants.status}`,
    teamParticipants.status === 200 &&
      bodyHasValue(teamParticipants.body, USERS.candB.username) &&
      bodyHasValue(teamParticipants.body, USERS.candC.username),
  );

  const teamCancel = teamId
    ? await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams/${teamId}/registrations`, {
        method: "DELETE",
        cookie: sessions.candB,
        headers: { "X-Expected-User-Id": USERS.candB.id },
        json: { cancellationReason: "Pembatalan oleh uji otomatis." },
      })
    : { status: 0, body: "skipped: no team id" };
  record(
    "TEAM-06",
    "Team registration cancelled (team reverts to forming)",
    "2xx",
    `${teamCancel.status}`,
    teamCancel.status === 200,
    bodySnippet(teamCancel.body).slice(0, 90),
  );

  const teamDelete = teamId
    ? await apiFetch(`/api/v1/teams/${teamId}`, {
        method: "DELETE",
        cookie: sessions.candB,
        headers: { "X-Expected-User-Id": USERS.candB.id },
      })
    : { status: 0, body: "skipped: no team id" };
  // Disbanding is soft: invitations are cancelled and memberships deactivated, but the row and
  // its name persist. The seed reset is what actually clears the stage.
  record(
    "TEAM-07",
    "Team disbanded (soft — memberships deactivated, row retained)",
    "2xx",
    `${teamDelete.status}`,
    teamDelete.status === 200,
    bodySnippet(teamDelete.body).slice(0, 90),
  );

  // ---- institution invitations: username invite, accept, membership, restore -
  const instInvite = await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations`, {
    method: "POST",
    cookie: sessions.recElev,
    json: { invitedIdentifier: USERS.candC.username, invitedRole: "institution_member" },
  });
  const instInviteId = instInvite.body?.invitation?.id ?? instInvite.body?.id ?? null;
  record(
    "INV-01",
    "Institution invite by USERNAME resolves to a target user",
    "201 + not pending_claim",
    `${instInvite.status}`,
    instInvite.status === 201 && !bodyHasValue(instInvite.body, "pending_claim"),
    bodySnippet(instInvite.body).slice(0, 90),
  );

  // Acceptance by an EXISTING recruiter-verified account — the branch the pending_claim manual
  // check does not reach. It raises its OWN invitation rather than consuming seed-instinv-1:
  // acceptance is terminal, so spending the seeded one would make every rerun without a reseed
  // fail on an already-accepted invitation. The target is recDraft, not recRej, because recRej
  // already holds that seeded pending staff invite and a second one is refused as a duplicate.
  const staffInvite = await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations`, {
    method: "POST",
    cookie: sessions.recElev,
    json: { invitedIdentifier: USERS.recDraft.username, invitedRole: "institution_staff" },
  });
  const staffInviteId = staffInvite.body?.invitation?.id ?? staffInvite.body?.id ?? null;
  const staffAccept = staffInviteId
    ? await apiFetch(`/api/v1/me/invitations/institution/${staffInviteId}/accept`, {
        method: "POST",
        cookie: sessions.recDraft,
        headers: { "X-Expected-User-Id": USERS.recDraft.id },
        json: {},
      })
    : { status: 0, body: "skipped: no invitation id" };
  // This pairing with INV-04 is also the regression guard for the rejoin defect it exposed:
  // removeMember soft-sets status='revoked' to keep the audit trail, and acceptance used to match
  // membership rows without filtering on status, so a removed member could be re-invited (the
  // creation guard does filter on 'active') and could then never accept. Running INV-02 → INV-04 →
  // INV-02 again is precisely what catches it, which is why this block must stay re-runnable
  // without a reseed.
  record(
    "INV-02",
    "Existing verified recruiter accepts a staff invitation",
    "2xx",
    `${staffInvite.status} → ${staffAccept.status}`,
    staffInvite.status === 201 && staffAccept.status === 200,
    staffInvite.status >= 300
      ? `invite refused: ${bodySnippet(staffInvite.body).slice(0, 90)}`
      : bodySnippet(staffAccept.body).slice(0, 90),
  );

  const members = await apiFetch(`/api/v1/institutions/${INST.a.slug}/members`, {
    cookie: sessions.recElev,
  });
  const memberRows = members.body?.members ?? members.body?.data ?? [];
  const newMember = Array.isArray(memberRows)
    ? memberRows.find((m) => (m.userId ?? m.user?.id) === USERS.recDraft.id)
    : null;
  record(
    "INV-03",
    "Accepted invitee appears in the institution member list",
    "recDraft present",
    `${members.status} ${newMember ? "present" : "absent"}`,
    members.status === 200 && Boolean(newMember),
  );

  const memberRemove = newMember?.membershipId
    ? await apiFetch(`/api/v1/institutions/${INST.a.slug}/members/${newMember.membershipId}`, {
        method: "DELETE",
        cookie: sessions.recElev,
      })
    : { status: 0, body: "skipped: no membership id" };
  record(
    "INV-04",
    "Membership removed — roster restored",
    "2xx",
    `${memberRemove.status}`,
    memberRemove.status === 204,
    bodySnippet(memberRemove.body).slice(0, 90),
  );

  const inviteCancel = instInviteId
    ? await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations/${instInviteId}/cancel`, {
        method: "PATCH",
        cookie: sessions.recElev,
        json: {},
      })
    : { status: 0, body: "skipped: no invitation id" };
  record(
    "INV-05",
    "Automation-created invitation cancelled — queue restored",
    "2xx",
    `${inviteCancel.status}`,
    inviteCancel.status === 200,
    bodySnippet(inviteCancel.body).slice(0, 90),
  );

  // ---- moderation: reinstatement, and institution suspension as a publish gate
  const unsuspend = await apiFetch(`/api/platform-ops/users/${USERS.susp.id}/unsuspend`, {
    method: "POST",
    cookie: sessions.ops,
    json: { reason: "Reinstatement oleh uji otomatis." },
  });
  const reinstatedLogin = await mintSession(USERS.susp.email);
  record(
    "MOD-01",
    "Reinstated account can log in again",
    "session issued",
    `${unsuspend.status} / ${reinstatedLogin.ok ? "session" : String(reinstatedLogin.error)}`,
    unsuspend.status === 200 && reinstatedLogin.ok,
  );

  const resuspend = await apiFetch(`/api/platform-ops/users/${USERS.susp.id}/suspend`, {
    method: "POST",
    cookie: sessions.ops,
    json: { reason: "Penangguhan data uji" },
  });
  const blockedAgain = await mintSession(USERS.susp.email);
  record(
    "MOD-02",
    "Re-suspended account is blocked again (seed state restored)",
    "ACCOUNT_SUSPENDED",
    `${resuspend.status} / ${String(blockedAgain.error)}`,
    resuspend.status === 200 && !blockedAgain.ok && blockedAgain.error === "ACCOUNT_SUSPENDED",
  );

  const suspendInst = await apiFetch(`/api/platform-ops/institutions/${INST.b.id}/suspend`, {
    method: "POST",
    cookie: sessions.ops,
    json: { reason: "Penangguhan sementara oleh uji otomatis." },
  });
  record(
    "MOD-03",
    "Institution suspended by ops",
    "2xx",
    `${suspendInst.status}`,
    suspendInst.status === 200,
    bodySnippet(suspendInst.body).slice(0, 80),
  );

  const publishWhileSuspended = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: {},
    },
  );
  record(
    "MOD-04",
    "Publish refused while the institution is suspended",
    "403 institution_suspended",
    `${publishWhileSuspended.status} ${errorCode(publishWhileSuspended)}`,
    refusedWith(publishWhileSuspended, 403, "institution_suspended"),
    bodySnippet(publishWhileSuspended.body).slice(0, 100),
  );

  const reinstateInst = await apiFetch(`/api/platform-ops/institutions/${INST.b.id}/reinstate`, {
    method: "POST",
    cookie: sessions.ops,
    json: { reason: "Pemulihan oleh uji otomatis." },
  });
  const publishAfterReinstate = await apiFetch(
    `/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: {},
    },
  );
  await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/unpublish`, {
    method: "POST",
    cookie: sessions.recElev,
    json: {},
  });
  record(
    "MOD-05",
    "Reinstated institution can publish again (state restored)",
    "2xx then 200",
    `${reinstateInst.status} / ${publishAfterReinstate.status}`,
    reinstateInst.status === 200 && publishAfterReinstate.status === 200,
  );

  // ---- featured placement, asserted where it actually matters: the listing ---
  // Ordering is asserted RELATIVE to a known unfeatured seed competition, never by absolute index:
  // the same database also holds whatever the owner created during the manual pass, so index 0 is
  // not a stable fact about this app.
  const listingSlugs = async () => {
    const r = await apiFetch("/api/v1/competitions?limit=100");
    return (r.body?.data ?? []).map((c) => c.slug);
  };
  const rankOf = (slugs, slug) => slugs.indexOf(slug);

  const baseSlugs = await listingSlugs();
  record(
    "FEAT-01",
    "Featured competition outranks an unfeatured one in the listing",
    `${COMP.featured.slug} before ${COMP.open.slug}`,
    `${rankOf(baseSlugs, COMP.featured.slug)} vs ${rankOf(baseSlugs, COMP.open.slug)}`,
    rankOf(baseSlugs, COMP.featured.slug) >= 0 &&
      rankOf(baseSlugs, COMP.featured.slug) < rankOf(baseSlugs, COMP.open.slug),
  );

  const setFeatured = await apiFetch(`/api/platform-ops/competitions/${COMP.closing.id}/featured`, {
    method: "PATCH",
    cookie: sessions.ops,
    json: { isFeatured: true, featuredOrder: 2 },
  });
  const promotedSlugs = await listingSlugs();
  record(
    "FEAT-02",
    "Newly featured competition rises above the unfeatured block",
    `${COMP.closing.slug} before ${COMP.open.slug}`,
    `${setFeatured.status}: ${rankOf(promotedSlugs, COMP.closing.slug)} vs ${rankOf(promotedSlugs, COMP.open.slug)}`,
    setFeatured.status === 200 &&
      rankOf(promotedSlugs, COMP.closing.slug) >= 0 &&
      rankOf(promotedSlugs, COMP.closing.slug) < rankOf(promotedSlugs, COMP.open.slug),
  );

  const clearFeatured = await apiFetch(
    `/api/platform-ops/competitions/${COMP.closing.id}/featured`,
    {
      method: "PATCH",
      cookie: sessions.ops,
      json: { isFeatured: false, featuredOrder: null },
    },
  );
  const clearedSlugs = await listingSlugs();
  record(
    "FEAT-03",
    "Cleared placement drops back below the featured block (seed restored)",
    `${COMP.featured.slug} before ${COMP.closing.slug}`,
    `${clearFeatured.status}: ${rankOf(clearedSlugs, COMP.featured.slug)} vs ${rankOf(clearedSlugs, COMP.closing.slug)}`,
    clearFeatured.status === 200 &&
      rankOf(clearedSlugs, COMP.featured.slug) < rankOf(clearedSlugs, COMP.closing.slug),
  );

  // ---- institution verification: revocation is possible, no status terminal --
  const verifyPath = `/api/admin/institutions/${INST.a.id}/verify`;
  const revokeNoReason = await apiFetch(verifyPath, {
    method: "PATCH",
    cookie: sessions.ops,
    json: { targetStatus: "rejected" },
  });
  record(
    "VERIF-01",
    "Revocation without a reason refused",
    "422 verification_reason_required",
    `${revokeNoReason.status}`,
    revokeNoReason.status === 422,
    bodySnippet(revokeNoReason.body).slice(0, 90),
  );

  const revoke = await apiFetch(verifyPath, {
    method: "PATCH",
    cookie: sessions.ops,
    json: { targetStatus: "rejected", reason: "Pencabutan oleh uji otomatis." },
  });
  record(
    "VERIF-02",
    "Verified institution can have verification revoked (verified->rejected)",
    "200",
    `${revoke.status}`,
    revoke.status === 200,
    bodySnippet(revoke.body).slice(0, 80),
  );

  const reVerify = await apiFetch(verifyPath, {
    method: "PATCH",
    cookie: sessions.ops,
    json: { targetStatus: "verified" },
  });
  record(
    "VERIF-03",
    "Revoked institution can be re-verified (rejected->verified, seed restored)",
    "200",
    `${reVerify.status}`,
    reVerify.status === 200,
    bodySnippet(reVerify.body).slice(0, 80),
  );

  // ---- participation decision (minimum-entry commitment lapsed on seed-closed) ----
  const partDecisionAsOutsider = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`,
    {
      method: "POST",
      cookie: sessions.candA,
      json: { decision: "proceed" },
    },
  );
  record(
    "PART-01",
    "Participation decision refused for candidate",
    "403",
    `${partDecisionAsOutsider.status} ${errorCode(partDecisionAsOutsider)}`,
    partDecisionAsOutsider.status === 403,
  );

  const partDecisionOutsiderRec = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`,
    {
      method: "POST",
      cookie: sessions.recMin,
      json: { decision: "proceed" },
    },
  );
  record(
    "PART-02",
    "Participation decision refused for a non-member recruiter",
    "403",
    `${partDecisionOutsiderRec.status} ${errorCode(partDecisionOutsiderRec)}`,
    partDecisionOutsiderRec.status === 403,
  );

  const partDecisionBadValue = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: { decision: "mungkin" },
    },
  );
  record(
    "PART-03",
    "Participation decision rejects an unknown decision value",
    "400",
    `${partDecisionBadValue.status}`,
    partDecisionBadValue.status === 400,
    bodySnippet(partDecisionBadValue.body).slice(0, 90),
  );

  // One-way by design (CAS on participation_confirmed_at IS NULL). The seed clears it on reset;
  // there is no API path back, which is why this is the last mutation in the block.
  const partDecisionProceed = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`,
    {
      method: "POST",
      cookie: sessions.recElev,
      json: { decision: "proceed" },
    },
  );
  record(
    "PART-04",
    "Owner confirms the competition will proceed despite low entries",
    "200",
    `${partDecisionProceed.status}`,
    partDecisionProceed.status === 200,
    partDecisionProceed.status === 409
      ? "409 here means the decision was already taken — reseed before rerunning (one-way by design)"
      : bodySnippet(partDecisionProceed.body).slice(0, 90),
  );

  // ---- rate limit (LAST — pollutes the per-IP identify bucket for 60s) -----
  let got429 = false;
  for (let i = 0; i < 65 && !got429; i++) {
    const r = await apiFetch("/api/v1/auth/identify", {
      method: "POST",
      json: { email: "burst@seed.lombakita.local" },
    });
    if (r.status === 429) got429 = true;
  }
  record(
    "RATE-01",
    "identify rate limit fires within 65 rapid calls",
    "429 observed",
    got429 ? "429" : "never",
    got429,
  );

  // ---- finance_ops: what it may read, and the boundary that actually exists ----
  //
  // THE USUAL TENANT NEGATIVE INVERTS HERE. Every other reader in this lane is confined to one
  // institution and the thing to prove is that it cannot see its neighbour's rows. finance_ops is a
  // PLATFORM role handling disputes that arrive from any institution, so reading across tenants is
  // the requirement, not the leak. The boundary that exists is ROLE: nobody else reaches this
  // surface, and finance_ops reaches no verdict.
  const finView = await apiFetch("/api/finance-ops/payment-proofs/seed-proof-b/view", {
    method: "POST",
    cookie: sessions.finOps,
  });
  // WHICH ANSWER IS CORRECT IS DECIDED BEFORE THE CALL, not accepted afterwards. A machine with no
  // object storage answers 503 — the role gate and the proof lookup both ran and only the presigner
  // was unavailable — and a machine with storage answers 200. Accepting either meant a storage
  // outage on a configured machine read as a pass, on the one lane where "we have your transfer"
  // has to be true.
  record(
    "FIN-01",
    "finance_ops may open a bukti transfer for dispute handling",
    `${storageExpectation}`,
    `${finView.status}`,
    finView.status === storageExpectation,
    bodySnippet(finView.body).slice(0, 90),
  );

  const finViewOther = await apiFetch("/api/finance-ops/payment-proofs/seed-proof-d/view", {
    method: "POST",
    cookie: sessions.finOps,
  });
  // A DIFFERENT INSTITUTION's proof (seed-inst-d's competition). Reachable ON PURPOSE. This is the
  // cross-tenant positive, and a 403 here would mean disputes could only be handled by guessing
  // which tenant they came from.
  record(
    "FIN-02",
    "finance_ops reads across tenants by design",
    `${storageExpectation}`,
    `${finViewOther.status}`,
    finViewOther.status === storageExpectation,
  );

  for (const [key, label] of [
    ["recElev", "recruiter"],
    ["candA", "candidate"],
    ["ops", "platform_ops"],
  ]) {
    const refused = await apiFetch("/api/finance-ops/payment-proofs/seed-proof-b/view", {
      method: "POST",
      cookie: sessions[key],
    });
    // ASSERTED ON THE CODE, NOT THE STATUS, and that distinction is load-bearing: an unelevated
    // operational session is also refused 403, with `mfa_challenge_required`. A status-only check
    // here would report a role boundary that was never reached. platform_ops is refused too, and
    // deliberately: the two operator roles keep separate audit trails, and letting either mint the
    // other's makes "who looked at this receipt" a question the log can no longer answer.
    const refusalCode = refused.body?.error?.code ?? "";
    record(
      `FIN-03-${label}`,
      `Dispute file access refused for ${label} (role, not MFA)`,
      "403 forbidden",
      `${refused.status} ${refusalCode}`,
      refused.status === 403 && refusalCode !== "mfa_challenge_required",
    );
  }

  const finViewAnon = await apiFetch("/api/finance-ops/payment-proofs/seed-proof-b/view", {
    method: "POST",
  });
  record(
    "FIN-04",
    "Dispute file access refused anon",
    "401",
    `${finViewAnon.status} ${errorCode(finViewAnon)}`,
    finViewAnon.status === 401,
  );

  // DEC-0162 AT THE HTTP LAYER. Withholding the controls in the UI is presentation; these two are
  // the enforcement, and they are what makes "no verdict power" true rather than merely displayed.
  const finVoid = await apiFetch("/api/platform-ops/payments/proofs/seed-proof-b/void", {
    method: "POST",
    cookie: sessions.finOps,
    json: { reason: "percobaan finance_ops" },
  });
  record(
    "FIN-05",
    "finance_ops cannot void a bukti transfer",
    "403",
    `${finVoid.status}`,
    finVoid.status === 403,
  );

  const finVerdict = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.paid.id}/payment-proofs/seed-proof-b`,
    {
      method: "PATCH",
      cookie: sessions.finOps,
      json: { action: "verify" },
    },
  );
  record(
    "FIN-06",
    "finance_ops cannot render the organiser's verdict",
    "403",
    `${finVerdict.status}`,
    finVerdict.status === 403,
  );

  const finCancel = await apiFetch(`/api/platform-ops/competitions/${COMP.paid.id}/cancel`, {
    method: "POST",
    cookie: sessions.finOps,
    json: { reason: "percobaan finance_ops" },
  });
  record(
    "FIN-07",
    "finance_ops cannot cancel a competition",
    "403",
    `${finCancel.status}`,
    finCancel.status === 403,
  );

  // ---- write artifacts ------------------------------------------------------
  mkdirSync(`${REPO}/test-artifacts/behavior`, { recursive: true });
  writeFileSync(
    `${REPO}/test-artifacts/behavior/api-matrix.json`,
    JSON.stringify(results, null, 2),
  );
  const md = [
    "# API Guard & Behavior Matrix",
    `Run: ${new Date().toISOString()} — ${results.filter((r) => r.pass).length}/${results.length} passed`,
    "",
    "| ID | Check | Expected | Actual | Pass | Note |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.name} | ${r.expected} | ${String(r.actual).replaceAll("|", "/")} | ${r.pass ? "✅" : "❌"} | ${String(r.note).replaceAll("|", "/").slice(0, 120)} |`,
    ),
  ].join("\n");
  writeFileSync(`${REPO}/test-artifacts/behavior/api-matrix.md`, md);
  console.log(
    `\n${results.filter((r) => r.pass).length}/${results.length} passed. Artifacts written to test-artifacts/behavior/api-matrix.{json,md}`,
  );
  if (results.some((r) => !r.pass)) process.exitCode = 1;
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
