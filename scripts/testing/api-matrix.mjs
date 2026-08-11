/**
 * API guard & behavior matrix — terminal-only assertions (no UI). Covers auth branches,
 * role gates, ownership/IDOR collapses, Rule-16 session-mismatch, publish gates, ops guards.
 * Writes test-artifacts/behavior/api-matrix.{json,md} in the repo.
 */
import { writeFileSync, mkdirSync } from "fs";
import { mintSession, apiFetch } from "./lib-auth.mjs";
import { USERS, INST, COMP, REG } from "./seeds.mjs";

const REPO = "/Users/nikau/Developer/lombakita";
const results = [];

const record = (id, name, expected, actual, pass, note = "") => {
  results.push({ id, name, expected, actual, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}  [expected ${expected} | got ${actual}]${note ? "  — " + note : ""}`);
};

const bodySnippet = (body) =>
  (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200);

// A step that could not run returns the sentinel `status: 0`, and `status < 300` would report
// that as a PASS — a skipped assertion is not a satisfied one.
const is2xx = (r) => r.status >= 200 && r.status < 300;

const main = async () => {
  // ---- sessions -----------------------------------------------------------
  const sessions = {};
  const sessionKeys = ["candA", "candB", "candC", "recMin", "recElev", "recRej", "recDraft", "dual", "ops"];
  for (const key of sessionKeys) {
    const s = await mintSession(USERS[key].email);
    if (!s.ok) throw new Error(`Could not mint session for ${key}: ${s.error}`);
    sessions[key] = s.cookie;
  }
  record("AUTH-01", "Login succeeds for all seeded active accounts", `${sessionKeys.length} sessions`, `${Object.keys(sessions).length} sessions`, Object.keys(sessions).length === sessionKeys.length);

  // ---- auth negative branches --------------------------------------------
  const wrongPw = await mintSession(USERS.candA.email, "SalahTotal999!");
  record("AUTH-02", "Wrong password rejected", "error, no session", wrongPw.ok ? "session!" : String(wrongPw.error), !wrongPw.ok);

  const susp = await mintSession(USERS.susp.email);
  record("AUTH-03", "Suspended account blocked at login (ACCOUNT_SUSPENDED)", "ACCOUNT_SUSPENDED", String(susp.error), !susp.ok && susp.error === "ACCOUNT_SUSPENDED");

  const unver = await mintSession(USERS.unver.email);
  record("AUTH-04", "Unverified email blocked at login (EMAIL_NOT_VERIFIED)", "EMAIL_NOT_VERIFIED", String(unver.error), !unver.ok && unver.error === "EMAIL_NOT_VERIFIED");

  // identify classification
  for (const [id, email, want] of [
    ["AUTH-05", USERS.candA.email, "verified"],
    ["AUTH-06", USERS.unver.email, "unverified"],
    ["AUTH-07", "tidak.ada@seed.lombakita.local", "none"],
  ]) {
    const r = await apiFetch("/api/v1/auth/identify", { method: "POST", json: { email } });
    const got = JSON.stringify(r.body);
    record(id, `identify(${email.split("@")[0]}) classifies '${want}'`, want, got.slice(0, 60), r.status === 200 && got.includes(want));
  }

  // ---- public reads -------------------------------------------------------
  const health = await apiFetch("/api/health");
  record("PUB-01", "GET /api/health all-ok", "200 ok", `${health.status}`, health.status === 200 && JSON.stringify(health.body).includes('"ok"'));

  const list = await apiFetch("/api/v1/competitions");
  const listStr = JSON.stringify(list.body);
  record("PUB-02", "Public listing shows open comps, hides drafts", "seed-open ∧ ¬seed-draft", `${list.status}`, list.status === 200 && listStr.includes("seed-open") && !listStr.includes('"seed-draft"'));
  record("PUB-03", "Default listing hides finished comps", "¬seed-done", listStr.includes('"seed-done"') ? "shown" : "hidden", !listStr.includes('"seed-done"'));

  const listAll = await apiFetch("/api/v1/competitions?status=all");
  const listAllStr = JSON.stringify(listAll.body);
  record("PUB-04", "status=all includes finished comps", "seed-done present", listAllStr.includes('"seed-done"') ? "present" : "absent", listAllStr.includes('"seed-done"'));

  const detail = await apiFetch(`/api/v1/competitions/public/${INST.a.slug}/${COMP.open.slug}`);
  record("PUB-05", "Public detail of published comp", "200", `${detail.status}`, detail.status === 200 && JSON.stringify(detail.body).includes("Seed Hackathon"));

  const draftDetail = await apiFetch(`/api/v1/competitions/public/${INST.a.slug}/${COMP.draft.slug}`);
  record("PUB-06", "Public detail of DRAFT comp is 404", "404", `${draftDetail.status}`, draftDetail.status === 404);

  const personalDetail = await apiFetch(`/api/v1/competitions/public/${INST.p.slug}/${COMP.personalOpen.slug}`);
  record("PUB-07", "Personal-institution comp public detail (derived organizer)", "200", `${personalDetail.status}`, personalDetail.status === 200, bodySnippet(personalDetail.body).slice(0, 80));

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
  record("CAND-02", "cand.a inbox lists seeded notifications", "200 + items", `${inbox.status}`, inbox.status === 200 && JSON.stringify(inbox.body).includes("Hasil kompetisi diumumkan"));

  // Inbox count spans notifications AND pending invitations: 2 unread notifs + 1 pending team invite.
  const unread = await apiFetch("/api/v1/me/inbox/unread-count", { cookie: sessions.candA });
  record("CAND-03", "Unread count = 3 (2 notifs + 1 pending invite)", "3", bodySnippet(unread.body), unread.status === 200 && unread.body?.unreadCount === 3);

  const saved = await apiFetch("/api/v1/me/saved-competitions", { cookie: sessions.candA });
  const savedStr = JSON.stringify(saved.body);
  record("CAND-04", "Saved list has 3 seeded saves", "3 slugs", `${saved.status}`, saved.status === 200 && ["seed-open", "seed-upcoming", "seed-done"].every((s) => savedStr.includes(s)));

  const candProf = await apiFetch("/api/v1/candidate/me/profile", { cookie: sessions.candA });
  record("CAND-05", "Candidate onboarding profile readable by owner", "200", `${candProf.status}`, candProf.status === 200 && JSON.stringify(candProf.body).includes("Andi Saputra"));

  const candProfAsRec = await apiFetch("/api/v1/candidate/me/profile", { cookie: sessions.recMin });
  record("CAND-06", "Candidate profile refused for recruiter-only account", "403", `${candProfAsRec.status}`, candProfAsRec.status === 403);

  const docReqs = await apiFetch("/api/v1/me/document-requests", { cookie: sessions.candA });
  record("CAND-07", "Candidate sees own document requests", "200 + Kartu Pelajar", `${docReqs.status}`, docReqs.status === 200 && JSON.stringify(docReqs.body).includes("Kartu Pelajar"));

  const resultOwn = await apiFetch(`/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.aDone}/result`, { cookie: sessions.candA });
  record("CAND-08", "Published result visible to owner (Juara 1)", "200", `${resultOwn.status}`, resultOwn.status === 200 && JSON.stringify(resultOwn.body).includes("Juara 1"));

  const resultForeign = await apiFetch(`/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`, { cookie: sessions.candA });
  record("CAND-09", "Foreign registration result IDOR collapses", "404", `${resultForeign.status}`, resultForeign.status === 404);

  const resultDraft = await apiFetch(`/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`, { cookie: sessions.candB });
  record("CAND-10", "DRAFT result not visible to its own candidate", "404/empty", `${resultDraft.status}`, resultDraft.status === 404 || !JSON.stringify(resultDraft.body).includes("Juara 2"), bodySnippet(resultDraft.body).slice(0, 80));

  // Rule 16 session-mismatch guard
  const mismatch = await apiFetch("/api/v1/candidate/me/profile", {
    method: "PATCH", cookie: sessions.candA,
    headers: { "X-Expected-User-Id": USERS.candB.id },
    json: { fullName: "X", phoneNumber: "+62812", occupation: "other", dateOfBirth: "2000-01-01" },
  });
  record("CAND-11", "Rule-16 session mismatch → 409", "409", `${mismatch.status}`, mismatch.status === 409, bodySnippet(mismatch.body).slice(0, 80));

  // save / unsave round-trip on a comp not seeded as saved
  const saveRes = await apiFetch(`/api/v1/competitions/${COMP.closing.id}/save`, {
    method: "POST", cookie: sessions.candA, headers: { "X-Expected-User-Id": USERS.candA.id },
  });
  const unsaveRes = await apiFetch(`/api/v1/competitions/${COMP.closing.id}/save`, {
    method: "DELETE", cookie: sessions.candA, headers: { "X-Expected-User-Id": USERS.candA.id },
  });
  record("CAND-12", "Save then unsave round-trip", "2xx,2xx", `${saveRes.status},${unsaveRes.status}`, is2xx(saveRes) && is2xx(unsaveRes));

  // registration refusals
  const regClosed = await apiFetch(`/api/v1/competitions/${COMP.closed.id}/registrations`, {
    method: "POST", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id }, json: {},
  });
  record("CAND-13", "Register after deadline refused (code registration_deadline_passed)", "4xx + code", `${regClosed.status}`, regClosed.status >= 400 && regClosed.status < 500 && JSON.stringify(regClosed.body).includes("registration_deadline_passed"), "HTTP 409 — uat-script.md claims 400 (doc drift)");

  const regDup = await apiFetch(`/api/v1/competitions/${COMP.open.id}/registrations`, {
    method: "POST", cookie: sessions.candA, headers: { "X-Expected-User-Id": USERS.candA.id }, json: {},
  });
  record("CAND-14", "Duplicate registration refused (already registered)", "4xx", `${regDup.status}`, regDup.status >= 400 && regDup.status < 500, bodySnippet(regDup.body).slice(0, 100));

  // cancellation policy gates
  const cxlNotAllowed = await apiFetch(`/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}`, {
    method: "DELETE", cookie: sessions.candA, headers: { "X-Expected-User-Id": USERS.candA.id }, json: { reason: "Uji pembatalan otomatis." },
  });
  record("CAND-15", "Cancel refused when allow_cancellation=false", "4xx", `${cxlNotAllowed.status}`, cxlNotAllowed.status >= 400 && cxlNotAllowed.status < 500, bodySnippet(cxlNotAllowed.body).slice(0, 100));

  // ---- recruiter / institution scoping ------------------------------------
  const rvOwn = await apiFetch("/api/v1/recruiter/me/verification", { cookie: sessions.recMin });
  record("REC-01", "Recruiter sees own verification submission", "200 pending_review", `${rvOwn.status}`, rvOwn.status === 200 && JSON.stringify(rvOwn.body).includes("pending_review"));

  const rvAsCand = await apiFetch("/api/v1/recruiter/me/verification", { cookie: sessions.candA });
  record("REC-02", "Recruiter verification refused for candidate", "403", `${rvAsCand.status}`, rvAsCand.status === 403);

  const compListOwner = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, { cookie: sessions.recElev });
  record("INST-01", "Owner lists institution competitions", "200", `${compListOwner.status}`, compListOwner.status === 200 && JSON.stringify(compListOwner.body).includes("seed-open"));

  const compListStaff = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, { cookie: sessions.dual });
  record("INST-02", "Staff (dual) lists institution competitions", "200", `${compListStaff.status}`, compListStaff.status === 200);

  const compListOutsider = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, { cookie: sessions.recMin });
  record("INST-03", "Non-member recruiter refused", "403/404", `${compListOutsider.status}`, compListOutsider.status === 403 || compListOutsider.status === 404);

  const compListCand = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions`, { cookie: sessions.candA });
  record("INST-04", "Candidate refused on institution surface", "403", `${compListCand.status}`, compListCand.status === 403 || compListCand.status === 404);

  const participants = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.open.id}/participants`, { cookie: sessions.recElev });
  record("INST-05", "Participants console lists registrants", "200 + names", `${participants.status}`, participants.status === 200 && JSON.stringify(participants.body).includes("seed_cand_a"), bodySnippet(participants.body).slice(0, 80));

  // Institution-scoped participants: a foreign competition id yields an EMPTY result set rather
  // than 404. The assertion is that no foreign data crosses.
  const crossTenant = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.open.id}/participants`, { cookie: sessions.recElev });
  const crossStr = JSON.stringify(crossTenant.body);
  record("INST-06", "Cross-institution participants leak nothing (empty set)", "0 participants", `${crossTenant.status} count=${crossTenant.body?.counts?.total}`, crossTenant.status === 404 || (crossTenant.body?.counts?.total === 0 && !crossStr.includes("seed_cand_a")));

  const crossTenantOutsider = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.open.id}/participants`, { cookie: sessions.recMin });
  record("INST-06b", "Outsider recruiter refused on another institution's participants", "403/404", `${crossTenantOutsider.status}`, crossTenantOutsider.status === 403 || crossTenantOutsider.status === 404);

  const exportCsv = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/export/registrants`, { cookie: sessions.recElev });
  record("INST-07", "Registrants CSV export", "200 text/csv", `${exportCsv.status} ${exportCsv.contentType.split(";")[0]}`, exportCsv.status === 200 && exportCsv.contentType.includes("csv"));

  const auditLog = await apiFetch(`/api/v1/institutions/${INST.a.slug}/audit-log`, { cookie: sessions.recElev });
  record("INST-08", "Audit log readable by owner", "200", `${auditLog.status}`, auditLog.status === 200);

  const orgSubmissionFile = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`, { cookie: sessions.recElev });
  record("INST-09", "Organizer gets presigned submission URL (audited read)", "200 + R2 signed url", `${orgSubmissionFile.status}`, orgSubmissionFile.status === 200 && String(orgSubmissionFile.body?.url ?? "").includes("X-Amz-Signature"));

  const orgSubmissionForeign = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`, { cookie: sessions.recElev });
  record("INST-10", "Submission file via wrong institution scope collapses", "404", `${orgSubmissionForeign.status}`, orgSubmissionForeign.status === 404);

  const orgSubmissionAsCand = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.aDone}/submission/file`, { cookie: sessions.candA });
  record("INST-11", "Candidate refused on organizer submission-file route", "403/404", `${orgSubmissionAsCand.status}`, orgSubmissionAsCand.status === 403 || orgSubmissionAsCand.status === 404);

  // publish gates
  const publishMinimal = await apiFetch(`/api/v1/institutions/${INST.p.slug}/competitions/${COMP.personalDraft.id}/publish`, {
    method: "POST", cookie: sessions.recMin, json: {},
  });
  record("GATE-01", "Publish refused for minimal-tier recruiter (Trusted gate)", "403", `${publishMinimal.status}`, publishMinimal.status === 403, bodySnippet(publishMinimal.body).slice(0, 100));

  const publishElev = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  record("GATE-02", "Publish succeeds for elevated recruiter (complete draft)", "200", `${publishElev.status}`, publishElev.status === 200, bodySnippet(publishElev.body).slice(0, 100));

  const unpublishElev = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/unpublish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  record("GATE-03", "Unpublish returns to draft (state restored, 0 registrations)", "200", `${unpublishElev.status}`, unpublishElev.status === 200);

  // immutable-after-publish on a published comp with registrations
  const immutable = await apiFetch(`/api/v1/competitions/${COMP.open.id}`, {
    method: "PATCH", cookie: sessions.recElev, json: { mode: "individual" },
  });
  record("GATE-04", "Post-publish mode change refused (immutable field)", "422", `${immutable.status}`, immutable.status === 422, bodySnippet(immutable.body).slice(0, 100));

  // ---- platform ops --------------------------------------------------------
  const opsQueue = await apiFetch("/api/platform-ops/recruiter-verification/pending", { cookie: sessions.ops });
  const opsQueueStr = JSON.stringify(opsQueue.body);
  record("OPS-01", "Recruiter verification queue (pending + rejected visible)", "200 + Rina + Raka", `${opsQueue.status}`, opsQueue.status === 200 && opsQueueStr.includes("Rina") && opsQueueStr.includes("Raka"));
  record("OPS-02", "Withdrawn draft invisible to ops queue", "no Dodi", opsQueueStr.includes("Dodi") ? "Dodi visible" : "hidden", !opsQueueStr.includes("Dodi"));

  const opsQueueAsRec = await apiFetch("/api/platform-ops/recruiter-verification/pending", { cookie: sessions.recElev });
  record("OPS-03", "Ops queue refused for recruiter", "403", `${opsQueueAsRec.status}`, opsQueueAsRec.status === 403);

  const instVerifQueue = await apiFetch("/api/platform-ops/verification/pending", { cookie: sessions.ops });
  record("OPS-04", "Institution verification queue shows Seed Ventures", "200", `${instVerifQueue.status}`, instVerifQueue.status === 200 && JSON.stringify(instVerifQueue.body).includes("Seed Ventures"));

  const adminInst = await apiFetch("/api/admin/institutions", { cookie: sessions.ops });
  record("OPS-05", "Admin institutions list for ops", "200", `${adminInst.status}`, adminInst.status === 200);
  const adminInstAnon = await apiFetch("/api/admin/institutions");
  record("OPS-06", "Admin institutions refused anon", "401/403", `${adminInstAnon.status}`, adminInstAnon.status === 401 || adminInstAnon.status === 403);

  const verifyRoleOps = await apiFetch("/api/v1/auth/verify-role", { method: "POST", cookie: sessions.ops, json: { role: "recruiter" } });
  record("OPS-07", "Operational account cannot self-verify participant role", "403", `${verifyRoleOps.status}`, verifyRoleOps.status === 403, bodySnippet(verifyRoleOps.body).slice(0, 80));

  // Profile fields are parsed FLAT off the body (not nested under candidateProfile).
  const verifyRoleDup = await apiFetch("/api/v1/auth/verify-role", {
    method: "POST", cookie: sessions.candA,
    json: { role: "candidate", fullName: "Andi Saputra", phoneNumber: "+6281200000001", occupation: "college_student", dateOfBirth: "2004-05-14" },
  });
  record("OPS-08", "Already-verified role returns 409", "409", `${verifyRoleDup.status}`, verifyRoleDup.status === 409, bodySnippet(verifyRoleDup.body).slice(0, 90));

  // A recruiter-only account, so the request gets past the already-verified gate and reaches
  // profile parsing. Sending candA here would 409 (OPS-08) and prove nothing about the payload.
  // The empty payload is refused before any grant, so this assertion does not mutate the seed.
  const verifyRoleNoProfile = await apiFetch("/api/v1/auth/verify-role", { method: "POST", cookie: sessions.recElev, json: { role: "candidate" } });
  record("OPS-09", "Candidate verify-role without profile payload refused", "400 candidate_profile_*", `${verifyRoleNoProfile.status}`, verifyRoleNoProfile.status === 400, bodySnippet(verifyRoleNoProfile.body).slice(0, 90));

  // The two orderings are distinguishable only when BOTH would fail: an account that already
  // holds the role, sending no payload. The caller must be told the role is already held.
  const verifyRoleDupNoProfile = await apiFetch("/api/v1/auth/verify-role", { method: "POST", cookie: sessions.candA, json: { role: "candidate" } });
  record("OPS-10", "Already-verified role answered before payload validation", "409 role_already_verified", `${verifyRoleDupNoProfile.status} ${verifyRoleDupNoProfile.body?.error?.code ?? ""}`.trim(), verifyRoleDupNoProfile.status === 409 && verifyRoleDupNoProfile.body?.error?.code === "role_already_verified");

  // ---- publish checklist (distinct from the tier gate above) ----------------
  // GATE-01 proves an under-tier recruiter is refused before the checklist runs. This is the other
  // half: a Trusted recruiter, an incomplete draft, and a refusal that names what is missing.
  const publishIncomplete = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.draft.id}/publish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  record("GATE-05", "Publish refused for incomplete draft, missing fields named", "422 + field list", `${publishIncomplete.status}`, publishIncomplete.status === 422 && JSON.stringify(publishIncomplete.body).length > 40, bodySnippet(publishIncomplete.body).slice(0, 110));

  // ---- result lifecycle: upsert -> publish -> unpublish -> restore ----------
  // Every assertion above reads results the seed wrote. This drives the organizer's write path and
  // puts the row back exactly as seeded, so the suite stays re-runnable.
  const resultPath = `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`;
  const candBResultPath = `/api/v1/me/competitions/${COMP.done.id}/registrations/${REG.bDone}/result`;

  const resultUpsert = await apiFetch(resultPath, {
    method: "PUT", cookie: sessions.recElev,
    json: { resultLabel: "Juara 2", resultNotes: "Draf internal — disunting oleh uji otomatis." },
  });
  record("RES-01", "Organizer upserts a result draft", "200", `${resultUpsert.status}`, resultUpsert.status === 200, bodySnippet(resultUpsert.body).slice(0, 80));

  const resultPublish = await apiFetch(`${resultPath}/publish`, { method: "POST", cookie: sessions.recElev, json: {} });
  record("RES-02", "Organizer publishes the result", "200", `${resultPublish.status}`, resultPublish.status === 200, bodySnippet(resultPublish.body).slice(0, 80));

  const resultNowVisible = await apiFetch(candBResultPath, { cookie: sessions.candB });
  record("RES-03", "Published result becomes visible to its own candidate", "200 + Juara 2", `${resultNowVisible.status}`, resultNowVisible.status === 200 && JSON.stringify(resultNowVisible.body).includes("Juara 2"));

  const resultUnpublish = await apiFetch(`${resultPath}/unpublish`, { method: "POST", cookie: sessions.recElev, json: {} });
  record("RES-04", "Organizer unpublishes the result", "200", `${resultUnpublish.status}`, resultUnpublish.status === 200);

  const resultHiddenAgain = await apiFetch(candBResultPath, { cookie: sessions.candB });
  record("RES-05", "Unpublished result collapses for the candidate again", "404/absent", `${resultHiddenAgain.status}`, resultHiddenAgain.status === 404 || !JSON.stringify(resultHiddenAgain.body).includes("Juara 2"));

  const resultRestore = await apiFetch(resultPath, {
    method: "PUT", cookie: sessions.recElev,
    json: { resultLabel: "Juara 2", resultNotes: "Draf internal — belum dipublikasikan." },
  });
  record("RES-06", "Seeded draft result restored verbatim", "200", `${resultRestore.status}`, resultRestore.status === 200);

  // ---- team lifecycle: create -> invite by username -> accept -> register ----
  // Runs on seed-comp-teamopen, the one team-capable competition kept free of registrations.
  // The name is unique per run because disbanding is SOFT: the row and its name survive, so a
  // fixed name collides with the previous run's team on the second pass.
  const teamName = `Tim Uji Otomatis ${Date.now()}`;
  const teamCreate = await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams`, {
    method: "POST", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id },
    json: { name: teamName },
  });
  const teamId = teamCreate.body?.team?.id ?? teamCreate.body?.id ?? null;
  record("TEAM-01", "Candidate creates a team on an open team competition", "2xx + team id", `${teamCreate.status} id=${teamId ?? "none"}`, is2xx(teamCreate) && Boolean(teamId), bodySnippet(teamCreate.body).slice(0, 90));

  // A username invite must resolve to a real target rather than falling through to the
  // pending_claim (unknown-email) branch — that distinction is the whole point of DEC-6.5e.
  const teamInvite = teamId
    ? await apiFetch(`/api/v1/teams/${teamId}/invitations`, {
        method: "POST", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id },
        json: { invitedIdentifier: USERS.candC.username },
      })
    : { status: 0, body: "skipped: no team id" };
  const teamInviteId = teamInvite.body?.invitation?.id ?? teamInvite.body?.id ?? null;
  const teamInviteEmail = teamInvite.body?.invitation?.invitedEmail ?? "(absent)";
  record("TEAM-02", "Team invite by USERNAME resolves to the right account's email", `${USERS.candC.email}`, `${teamInvite.status} ${teamInviteEmail}`, is2xx(teamInvite) && teamInviteEmail === USERS.candC.email);

  // The response carries no status field, so the targeted-vs-pending_claim branch is asserted where
  // it is actually observable: the inbox queries solely by target_user_id, so a pending_claim
  // invitation (null target) is invisible there by construction.
  const inviteeInbox = await apiFetch("/api/v1/me/inbox", { cookie: sessions.candC });
  record("TEAM-02b", "Targeted invite reaches the invitee's inbox (target_user_id was set)", "team invite present", `${inviteeInbox.status}`, inviteeInbox.status === 200 && JSON.stringify(inviteeInbox.body).includes(teamName), bodySnippet(inviteeInbox.body).slice(0, 90));

  const teamAccept = teamInviteId
    ? await apiFetch(`/api/v1/me/invitations/team/${teamInviteId}/accept`, {
        method: "POST", cookie: sessions.candC, headers: { "X-Expected-User-Id": USERS.candC.id }, json: {},
      })
    : { status: 0, body: "skipped: no invitation id" };
  record("TEAM-03", "Invited candidate accepts and joins the roster", "2xx", `${teamAccept.status}`, is2xx(teamAccept), bodySnippet(teamAccept.body).slice(0, 90));

  const teamRegister = teamId
    ? await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams/${teamId}/registrations`, {
        method: "POST", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id }, json: {},
      })
    : { status: 0, body: "skipped: no team id" };
  record("TEAM-04", "Captain submits the team registration", "2xx", `${teamRegister.status}`, is2xx(teamRegister), bodySnippet(teamRegister.body).slice(0, 90));

  const teamParticipants = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.teamOpen.id}/participants`, { cookie: sessions.recElev });
  const teamParticipantsStr = JSON.stringify(teamParticipants.body);
  record("TEAM-05", "Both team members appear to the organizer as registrants", "candB ∧ candC", `${teamParticipants.status}`, teamParticipants.status === 200 && teamParticipantsStr.includes(USERS.candB.username) && teamParticipantsStr.includes(USERS.candC.username));

  const teamCancel = teamId
    ? await apiFetch(`/api/v1/competitions/${COMP.teamOpen.id}/teams/${teamId}/registrations`, {
        method: "DELETE", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id },
        json: { cancellationReason: "Pembatalan oleh uji otomatis." },
      })
    : { status: 0, body: "skipped: no team id" };
  record("TEAM-06", "Team registration cancelled (team reverts to forming)", "2xx", `${teamCancel.status}`, is2xx(teamCancel), bodySnippet(teamCancel.body).slice(0, 90));

  const teamDelete = teamId
    ? await apiFetch(`/api/v1/teams/${teamId}`, {
        method: "DELETE", cookie: sessions.candB, headers: { "X-Expected-User-Id": USERS.candB.id },
      })
    : { status: 0, body: "skipped: no team id" };
  // Disbanding is soft: invitations are cancelled and memberships deactivated, but the row and
  // its name persist. The seed reset is what actually clears the stage.
  record("TEAM-07", "Team disbanded (soft — memberships deactivated, row retained)", "2xx", `${teamDelete.status}`, is2xx(teamDelete), bodySnippet(teamDelete.body).slice(0, 90));

  // ---- institution invitations: username invite, accept, membership, restore -
  const instInvite = await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations`, {
    method: "POST", cookie: sessions.recElev,
    json: { invitedIdentifier: USERS.candC.username, invitedRole: "institution_member" },
  });
  const instInviteId = instInvite.body?.invitation?.id ?? instInvite.body?.id ?? null;
  record("INV-01", "Institution invite by USERNAME resolves to a target user", "2xx + pending", `${instInvite.status}`, is2xx(instInvite) && !JSON.stringify(instInvite.body).includes("pending_claim"), bodySnippet(instInvite.body).slice(0, 90));

  // Acceptance by an EXISTING recruiter-verified account — the branch the pending_claim manual
  // check does not reach. It raises its OWN invitation rather than consuming seed-instinv-1:
  // acceptance is terminal, so spending the seeded one would make every rerun without a reseed
  // fail on an already-accepted invitation. The target is recDraft, not recRej, because recRej
  // already holds that seeded pending staff invite and a second one is refused as a duplicate.
  const staffInvite = await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations`, {
    method: "POST", cookie: sessions.recElev,
    json: { invitedIdentifier: USERS.recDraft.username, invitedRole: "institution_staff" },
  });
  const staffInviteId = staffInvite.body?.invitation?.id ?? staffInvite.body?.id ?? null;
  const staffAccept = staffInviteId
    ? await apiFetch(`/api/v1/me/invitations/institution/${staffInviteId}/accept`, {
        method: "POST", cookie: sessions.recDraft, headers: { "X-Expected-User-Id": USERS.recDraft.id }, json: {},
      })
    : { status: 0, body: "skipped: no invitation id" };
  // This pairing with INV-04 is also the regression guard for the rejoin defect it exposed:
  // removeMember soft-sets status='revoked' to keep the audit trail, and acceptance used to match
  // membership rows without filtering on status, so a removed member could be re-invited (the
  // creation guard does filter on 'active') and could then never accept. Running INV-02 → INV-04 →
  // INV-02 again is precisely what catches it, which is why this block must stay re-runnable
  // without a reseed.
  record("INV-02", "Existing verified recruiter accepts a staff invitation", "2xx", `${staffInvite.status} → ${staffAccept.status}`, is2xx(staffInvite) && is2xx(staffAccept), staffInvite.status >= 300 ? `invite refused: ${bodySnippet(staffInvite.body).slice(0, 90)}` : bodySnippet(staffAccept.body).slice(0, 90));

  const members = await apiFetch(`/api/v1/institutions/${INST.a.slug}/members`, { cookie: sessions.recElev });
  const memberRows = members.body?.members ?? members.body?.data ?? [];
  const newMember = Array.isArray(memberRows)
    ? memberRows.find((m) => (m.userId ?? m.user?.id) === USERS.recDraft.id)
    : null;
  record("INV-03", "Accepted invitee appears in the institution member list", "recDraft present", `${members.status} ${newMember ? "present" : "absent"}`, members.status === 200 && Boolean(newMember));

  const memberRemove = newMember?.membershipId
    ? await apiFetch(`/api/v1/institutions/${INST.a.slug}/members/${newMember.membershipId}`, { method: "DELETE", cookie: sessions.recElev })
    : { status: 0, body: "skipped: no membership id" };
  record("INV-04", "Membership removed — roster restored", "2xx", `${memberRemove.status}`, is2xx(memberRemove), bodySnippet(memberRemove.body).slice(0, 90));

  const inviteCancel = instInviteId
    ? await apiFetch(`/api/v1/institutions/${INST.a.slug}/invitations/${instInviteId}/cancel`, { method: "PATCH", cookie: sessions.recElev, json: {} })
    : { status: 0, body: "skipped: no invitation id" };
  record("INV-05", "Automation-created invitation cancelled — queue restored", "2xx", `${inviteCancel.status}`, is2xx(inviteCancel), bodySnippet(inviteCancel.body).slice(0, 90));

  // ---- moderation: reinstatement, and institution suspension as a publish gate
  const unsuspend = await apiFetch(`/api/platform-ops/users/${USERS.susp.id}/unsuspend`, {
    method: "POST", cookie: sessions.ops, json: { reason: "Reinstatement oleh uji otomatis." },
  });
  const reinstatedLogin = await mintSession(USERS.susp.email);
  record("MOD-01", "Reinstated account can log in again", "session issued", `${unsuspend.status} / ${reinstatedLogin.ok ? "session" : String(reinstatedLogin.error)}`, is2xx(unsuspend) && reinstatedLogin.ok);

  const resuspend = await apiFetch(`/api/platform-ops/users/${USERS.susp.id}/suspend`, {
    method: "POST", cookie: sessions.ops, json: { reason: "Penangguhan data uji" },
  });
  const blockedAgain = await mintSession(USERS.susp.email);
  record("MOD-02", "Re-suspended account is blocked again (seed state restored)", "ACCOUNT_SUSPENDED", `${resuspend.status} / ${String(blockedAgain.error)}`, is2xx(resuspend) && !blockedAgain.ok && blockedAgain.error === "ACCOUNT_SUSPENDED");

  const suspendInst = await apiFetch(`/api/platform-ops/institutions/${INST.b.id}/suspend`, {
    method: "POST", cookie: sessions.ops, json: { reason: "Penangguhan sementara oleh uji otomatis." },
  });
  record("MOD-03", "Institution suspended by ops", "2xx", `${suspendInst.status}`, is2xx(suspendInst), bodySnippet(suspendInst.body).slice(0, 80));

  const publishWhileSuspended = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  record("MOD-04", "Publish refused while the institution is suspended", "4xx", `${publishWhileSuspended.status}`, publishWhileSuspended.status >= 400 && publishWhileSuspended.status < 500, bodySnippet(publishWhileSuspended.body).slice(0, 100));

  const reinstateInst = await apiFetch(`/api/platform-ops/institutions/${INST.b.id}/reinstate`, {
    method: "POST", cookie: sessions.ops, json: { reason: "Pemulihan oleh uji otomatis." },
  });
  const publishAfterReinstate = await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/publish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  await apiFetch(`/api/v1/institutions/${INST.b.slug}/competitions/${COMP.bDraft.id}/unpublish`, {
    method: "POST", cookie: sessions.recElev, json: {},
  });
  record("MOD-05", "Reinstated institution can publish again (state restored)", "2xx then 200", `${reinstateInst.status} / ${publishAfterReinstate.status}`, is2xx(reinstateInst) && publishAfterReinstate.status === 200);

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
  record("FEAT-01", "Featured competition outranks an unfeatured one in the listing", `${COMP.featured.slug} before ${COMP.open.slug}`, `${rankOf(baseSlugs, COMP.featured.slug)} vs ${rankOf(baseSlugs, COMP.open.slug)}`, rankOf(baseSlugs, COMP.featured.slug) >= 0 && rankOf(baseSlugs, COMP.featured.slug) < rankOf(baseSlugs, COMP.open.slug));

  const setFeatured = await apiFetch(`/api/platform-ops/competitions/${COMP.closing.id}/featured`, {
    method: "PATCH", cookie: sessions.ops, json: { isFeatured: true, featuredOrder: 2 },
  });
  const promotedSlugs = await listingSlugs();
  record("FEAT-02", "Newly featured competition rises above the unfeatured block", `${COMP.closing.slug} before ${COMP.open.slug}`, `${setFeatured.status}: ${rankOf(promotedSlugs, COMP.closing.slug)} vs ${rankOf(promotedSlugs, COMP.open.slug)}`, is2xx(setFeatured) && rankOf(promotedSlugs, COMP.closing.slug) >= 0 && rankOf(promotedSlugs, COMP.closing.slug) < rankOf(promotedSlugs, COMP.open.slug));

  const clearFeatured = await apiFetch(`/api/platform-ops/competitions/${COMP.closing.id}/featured`, {
    method: "PATCH", cookie: sessions.ops, json: { isFeatured: false, featuredOrder: null },
  });
  const clearedSlugs = await listingSlugs();
  record("FEAT-03", "Cleared placement drops back below the featured block (seed restored)", `${COMP.featured.slug} before ${COMP.closing.slug}`, `${clearFeatured.status}: ${rankOf(clearedSlugs, COMP.featured.slug)} vs ${rankOf(clearedSlugs, COMP.closing.slug)}`, is2xx(clearFeatured) && rankOf(clearedSlugs, COMP.featured.slug) < rankOf(clearedSlugs, COMP.closing.slug));

  // ---- institution verification: revocation is possible, no status terminal --
  const verifyPath = `/api/admin/institutions/${INST.a.id}/verify`;
  const revokeNoReason = await apiFetch(verifyPath, { method: "PATCH", cookie: sessions.ops, json: { targetStatus: "rejected" } });
  record("VERIF-01", "Revocation without a reason refused", "422 verification_reason_required", `${revokeNoReason.status}`, revokeNoReason.status === 422, bodySnippet(revokeNoReason.body).slice(0, 90));

  const revoke = await apiFetch(verifyPath, { method: "PATCH", cookie: sessions.ops, json: { targetStatus: "rejected", reason: "Pencabutan oleh uji otomatis." } });
  record("VERIF-02", "Verified institution can have verification revoked (verified->rejected)", "200", `${revoke.status}`, revoke.status === 200, bodySnippet(revoke.body).slice(0, 80));

  const reVerify = await apiFetch(verifyPath, { method: "PATCH", cookie: sessions.ops, json: { targetStatus: "verified" } });
  record("VERIF-03", "Revoked institution can be re-verified (rejected->verified, seed restored)", "200", `${reVerify.status}`, reVerify.status === 200, bodySnippet(reVerify.body).slice(0, 80));

  // ---- participation decision (minimum-entry commitment lapsed on seed-closed) ----
  const partDecisionAsOutsider = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`, {
    method: "POST", cookie: sessions.candA, json: { decision: "proceed" },
  });
  record("PART-01", "Participation decision refused for candidate", "403/404", `${partDecisionAsOutsider.status}`, partDecisionAsOutsider.status === 403 || partDecisionAsOutsider.status === 404);

  const partDecisionOutsiderRec = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`, {
    method: "POST", cookie: sessions.recMin, json: { decision: "proceed" },
  });
  record("PART-02", "Participation decision refused for a non-member recruiter", "403/404", `${partDecisionOutsiderRec.status}`, partDecisionOutsiderRec.status === 403 || partDecisionOutsiderRec.status === 404);

  const partDecisionBadValue = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`, {
    method: "POST", cookie: sessions.recElev, json: { decision: "mungkin" },
  });
  record("PART-03", "Participation decision rejects an unknown decision value", "400", `${partDecisionBadValue.status}`, partDecisionBadValue.status === 400, bodySnippet(partDecisionBadValue.body).slice(0, 90));

  // One-way by design (CAS on participation_confirmed_at IS NULL). The seed clears it on reset;
  // there is no API path back, which is why this is the last mutation in the block.
  const partDecisionProceed = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`, {
    method: "POST", cookie: sessions.recElev, json: { decision: "proceed" },
  });
  record("PART-04", "Owner confirms the competition will proceed despite low entries", "200", `${partDecisionProceed.status}`, partDecisionProceed.status === 200, partDecisionProceed.status === 409 ? "409 here means the decision was already taken — reseed before rerunning (one-way by design)" : bodySnippet(partDecisionProceed.body).slice(0, 90));

  // ---- rate limit (LAST — pollutes the per-IP identify bucket for 60s) -----
  let got429 = false;
  for (let i = 0; i < 65 && !got429; i++) {
    const r = await apiFetch("/api/v1/auth/identify", { method: "POST", json: { email: "burst@seed.lombakita.local" } });
    if (r.status === 429) got429 = true;
  }
  record("RATE-01", "identify rate limit fires within 65 rapid calls", "429 observed", got429 ? "429" : "never", got429);

  // ---- write artifacts ------------------------------------------------------
  mkdirSync(`${REPO}/test-artifacts/behavior`, { recursive: true });
  writeFileSync(`${REPO}/test-artifacts/behavior/api-matrix.json`, JSON.stringify(results, null, 2));
  const md = [
    "# API Guard & Behavior Matrix",
    `Run: ${new Date().toISOString()} — ${results.filter((r) => r.pass).length}/${results.length} passed`,
    "",
    "| ID | Check | Expected | Actual | Pass | Note |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | ${r.expected} | ${String(r.actual).replaceAll("|", "/")} | ${r.pass ? "✅" : "❌"} | ${String(r.note).replaceAll("|", "/").slice(0, 120)} |`),
  ].join("\n");
  writeFileSync(`${REPO}/test-artifacts/behavior/api-matrix.md`, md);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed. Artifacts written to test-artifacts/behavior/api-matrix.{json,md}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
