/**
 * API guard & behavior matrix — terminal-only assertions (no UI). Covers auth branches,
 * role gates, ownership/IDOR collapses, Rule-16 session-mismatch, publish gates, ops guards.
 * Writes test-artifacts/behavior/api-matrix.{json,md} in the repo.
 */
import { writeFileSync, mkdirSync } from "fs";
import { mintSession, apiFetch } from "./lib-auth.mjs";
import { USERS, INST, COMP, REG } from "./seeds.mjs";

const REPO = "/Users/nikau/Desktop/lombakita";
const results = [];

const record = (id, name, expected, actual, pass, note = "") => {
  results.push({ id, name, expected, actual, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}  [expected ${expected} | got ${actual}]${note ? "  — " + note : ""}`);
};

const bodySnippet = (body) =>
  (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200);

const main = async () => {
  // ---- sessions -----------------------------------------------------------
  const sessions = {};
  for (const key of ["candA", "candB", "candC", "recMin", "recElev", "dual", "ops"]) {
    const s = await mintSession(USERS[key].email);
    if (!s.ok) throw new Error(`Could not mint session for ${key}: ${s.error}`);
    sessions[key] = s.cookie;
  }
  record("AUTH-01", "Login succeeds for all seeded active accounts", "7 sessions", "7 sessions", true);

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
  record("CAND-12", "Save then unsave round-trip", "2xx,2xx", `${saveRes.status},${unsaveRes.status}`, saveRes.status < 300 && unsaveRes.status < 300);

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
  // than 404 (Step 5.1 isolation shape). The assertion is that no foreign data crosses.
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

  // ---- participation decision (minimum-entry commitment lapsed on seed-closed) ----
  const partDecisionAsOutsider = await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closed.id}/participation-decision`, {
    method: "POST", cookie: sessions.candA, json: { decision: "proceed" },
  });
  record("PART-01", "Participation decision refused for candidate", "403/404", `${partDecisionAsOutsider.status}`, partDecisionAsOutsider.status === 403 || partDecisionAsOutsider.status === 404);

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
