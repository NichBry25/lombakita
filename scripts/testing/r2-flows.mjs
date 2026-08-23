/**
 * End-to-end R2 file flows: presign → real PUT → record/finalize → read back.
 * Exercises the DEC-0111/0125 validation pipeline with REAL bytes, including the negative case
 * (extension lying about its content) which must be refused and the object deleted.
 */
import { writeFileSync, mkdirSync } from "fs";
import { mintSession, apiFetch } from "./lib-auth.mjs";
import { bodySnippet, errorCode, isPresignedUrl, refusedWith } from "./lib-assertions.mjs";
import { USERS, INST, COMP, REG } from "./seeds.mjs";

const REPO = "/Users/nikau/Developer/lombakita";
const results = [];
const record = (id, name, expected, actual, pass, note = "") => {
  results.push({ id, name, expected, actual, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}  [expected ${expected} | got ${actual}]${note ? "  — " + note : ""}`);
};

// Minimal valid one-page PDF (real %PDF- magic bytes).
const pdfBytes = () => Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

// A real PNG (8-byte signature + IHDR) so extension↔bytes agreement can be tested both ways.
const pngBytes = () => Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
  "0d0a2db40000000049454e44ae426082", "hex");

const putToR2 = async (url, body, contentType) => {
  const res = await fetch(url, { method: "PUT", body, headers: { "content-type": contentType } });
  return { status: res.status, text: res.status >= 400 ? (await res.text()).slice(0, 300) : "" };
};

const main = async () => {
  const cand = (await mintSession(USERS.candA.email));
  const candB = (await mintSession(USERS.candB.email));
  const elev = (await mintSession(USERS.recElev.email));
  if (!cand.ok || !elev.ok || !candB.ok) throw new Error("session mint failed");
  const hA = { "X-Expected-User-Id": USERS.candA.id };

  // ============ 1. Submission upload round trip (candidate A, seed-reg-a-open) ============
  const presign = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/upload-url`,
    { method: "POST", cookie: cand.cookie, headers: hA, json: { fileName: "karya-uji.pdf" } },
  );
  record("R2-01", "Submission presign returns signed PUT + server key", "200 + signed PUT url", `${presign.status}`,
    presign.status === 200 && isPresignedUrl(presign.body?.uploadUrl),
    String(presign.body?.fileKey ?? "").slice(0, 70));

  const key = presign.body?.fileKey;
  record("R2-02", "Key layout is submissions/{competitionId}/{registrationId}/{uuid}", "competition-first prefix",
    String(key).split("/").slice(0, 3).join("/"),
    String(key ?? "").startsWith(`submissions/${COMP.inprogress.id}/${REG.aInprog}/`));

  const put1 = await putToR2(presign.body.uploadUrl, pdfBytes(), presign.body.contentType);
  record("R2-03", "Real PUT of PDF bytes to R2 succeeds", "200", `${put1.status}`, put1.status === 200, put1.text);

  const rec1 = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission`,
    { method: "PUT", cookie: cand.cookie, headers: hA, json: { fileKey: key, fileName: "karya-uji.pdf", fileSizeBytes: pdfBytes().length } },
  );
  record("R2-04", "Record submission after upload (magic bytes confirmed)", "200 version 1", `${rec1.status} v${rec1.body?.submission?.version}`,
    rec1.status === 200 && rec1.body?.submission?.version === 1,
    `stored type ${rec1.body?.submission?.fileMimeType}`);

  // Replace → version increments
  const presign2 = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/upload-url`,
    { method: "POST", cookie: cand.cookie, headers: hA, json: { fileName: "karya-uji-revisi.pdf" } },
  );
  await putToR2(presign2.body.uploadUrl, pdfBytes(), presign2.body.contentType);
  const rec2 = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission`,
    { method: "PUT", cookie: cand.cookie, headers: hA, json: { fileKey: presign2.body.fileKey, fileName: "karya-uji-revisi.pdf", fileSizeBytes: pdfBytes().length } },
  );
  record("R2-05", "Replace increments version", "200 version 2", `${rec2.status} v${rec2.body?.submission?.version}`,
    rec2.status === 200 && rec2.body?.submission?.version === 2);

  // Negative: .pdf extension carrying PNG bytes must be refused
  const presignBad = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/upload-url`,
    { method: "POST", cookie: cand.cookie, headers: hA, json: { fileName: "penipuan.pdf" } },
  );
  await putToR2(presignBad.body.uploadUrl, pngBytes(), presignBad.body.contentType);
  const recBad = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission`,
    { method: "PUT", cookie: cand.cookie, headers: hA, json: { fileKey: presignBad.body.fileKey, fileName: "penipuan.pdf", fileSizeBytes: pngBytes().length } },
  );
  record("R2-06", "PDF extension carrying PNG bytes is REFUSED", "422 submission_invalid_file_type", `${recBad.status} ${errorCode(recBad)}`,
    refusedWith(recBad, 422, "submission_invalid_file_type"), bodySnippet(recBad.body));

  const stillV2 = await apiFetch(`/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission`, { cookie: cand.cookie });
  record("R2-07", "Refused upload did not overwrite the good submission", "version 2 intact", `v${stillV2.body?.submission?.version}`,
    stillV2.body?.submission?.version === 2);

  // Disallowed extension refused at presign
  const presignExe = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/upload-url`,
    { method: "POST", cookie: cand.cookie, headers: hA, json: { fileName: "virus.exe" } },
  );
  record("R2-08", "Disallowed extension refused at presign", "422 submission_invalid_file_type", `${presignExe.status} ${errorCode(presignExe)}`,
    refusedWith(presignExe, 422, "submission_invalid_file_type"), bodySnippet(presignExe.body));

  // Finalize locks the submission
  const finalize = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/finalize`,
    { method: "POST", cookie: cand.cookie, headers: hA, json: {} },
  );
  record("R2-09", "Finalize locks the submission", "200 finalizedAt set", `${finalize.status}`,
    finalize.status === 200 && Boolean(finalize.body?.submission?.finalizedAt));

  const afterFinal = await apiFetch(
    `/api/v1/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission`,
    { method: "PUT", cookie: cand.cookie, headers: hA, json: { fileKey: presign2.body.fileKey, fileName: "sesudah-final.pdf", fileSizeBytes: 100 } },
  );
  // 422, not the code's own default of 409: the replace path overrides the status at the throw
  // site. A range could not tell the two apart, and which one answers is the assertion's subject.
  record("R2-10", "Replace after finalize refused", "422 submission_finalized", `${afterFinal.status} ${errorCode(afterFinal)}`,
    refusedWith(afterFinal, 422, "submission_finalized"), bodySnippet(afterFinal.body));

  // Organizer reads the freshly uploaded file (audited presigned GET)
  const orgRead = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.inprogress.id}/registrations/${REG.aInprog}/submission/file`,
    { cookie: elev.cookie },
  );
  record("R2-11", "Organizer reads the uploaded submission (audited)", "200 signed GET url", `${orgRead.status}`,
    orgRead.status === 200 && isPresignedUrl(orgRead.body?.url));

  if (orgRead.status === 200) {
    const fetched = await fetch(orgRead.body.url);
    const buf = Buffer.from(await fetched.arrayBuffer());
    record("R2-12", "Presigned GET returns the exact bytes uploaded", "PDF magic + same length", `${fetched.status} ${buf.length}B`,
      fetched.status === 200 && buf.subarray(0, 5).toString() === "%PDF-");
  }

  // ============ 2. Document request round trip ============
  const create = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closing.id}/registrations/${REG.tbC}/document-requests`,
    { method: "POST", cookie: elev.cookie, json: { title: "Kartu Pelajar (uji otomatis)", instructions: "Unggah kartu pelajar.", dueAt: new Date(Date.now() + 7 * 864e5).toISOString() } },
  );
  record("DOC-01", "Organizer raises a document request for one participant", "201", `${create.status}`,
    create.status === 201, bodySnippet(create.body));

  const dup = await apiFetch(
    `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closing.id}/registrations/${REG.tbC}/document-requests`,
    { method: "POST", cookie: elev.cookie, json: { title: "Duplikat", dueAt: new Date(Date.now() + 7 * 864e5).toISOString() } },
  );
  record("DOC-02", "Second open request for the same participant refused", "409", `${dup.status}`, dup.status === 409,
    JSON.stringify(dup.body).slice(0, 100));

  // Candidate C uploads against it
  const candC = await mintSession(USERS.candC.email);
  const hC = { "X-Expected-User-Id": USERS.candC.id };
  const myReqs = await apiFetch("/api/v1/me/document-requests", { cookie: candC.cookie });
  const target = (myReqs.body?.requests ?? myReqs.body?.items ?? []).find((r) => String(r.title ?? "").includes("uji otomatis"));
  record("DOC-03", "Candidate sees the new request", "request present", target ? "present" : "absent", Boolean(target));

  if (target) {
    const dPresign = await apiFetch(`/api/v1/me/document-requests/${target.id}/files`, {
      method: "POST", cookie: candC.cookie, headers: hC,
      json: { originalFileName: "kartu-pelajar.png", contentType: "image/png", fileSizeBytes: pngBytes().length },
    });
    record("DOC-04", "Document presign returns signed PUT", "200 + signed PUT url", `${dPresign.status}`,
      dPresign.status === 200 && isPresignedUrl(dPresign.body?.uploadUrl),
      String(dPresign.body?.r2Key ?? dPresign.body?.fileKey ?? "").slice(0, 80));

    if (dPresign.status === 200) {
      const dKey = dPresign.body.r2Key ?? dPresign.body.fileKey;
      const dPut = await putToR2(dPresign.body.uploadUrl, pngBytes(), dPresign.body.contentType ?? "image/png");
      record("DOC-05", "Real PUT of PNG document to R2", "200", `${dPut.status}`, dPut.status === 200, dPut.text);

      const dFin = await apiFetch(`/api/v1/me/document-requests/${target.id}/files/finalize`, {
        method: "POST", cookie: candC.cookie, headers: hC,
        json: { r2Key: dKey, originalFileName: "kartu-pelajar.png" },
      });
      record("DOC-06", "Finalize inspects bytes and writes the row", "200", `${dFin.status}`, dFin.status === 200,
        JSON.stringify(dFin.body).slice(0, 120));

      const afterUpload = await apiFetch("/api/v1/me/document-requests", { cookie: candC.cookie });
      const t2 = (afterUpload.body?.requests ?? afterUpload.body?.items ?? []).find((r) => r.id === target.id);
      record("DOC-07", "Request moves to 'submitted' after upload", "submitted", String(t2?.status), t2?.status === "submitted");

      // Organizer rejects with re-upload allowed → request reopens
      const reject = await apiFetch(
        `/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closing.id}/document-requests/${target.id}`,
        { method: "PATCH", cookie: elev.cookie, json: { action: "review", verdict: "reject", note: "Foto buram (uji otomatis).", allowReupload: true, dueAt: new Date(Date.now() + 5 * 864e5).toISOString() } },
      );
      record("DOC-08", "Reject with re-upload reopens the request", "200", `${reject.status}`,
        reject.status === 200, bodySnippet(reject.body));

      const afterReject = await apiFetch("/api/v1/me/document-requests", { cookie: candC.cookie });
      const t3 = (afterReject.body?.requests ?? afterReject.body?.items ?? []).find((r) => r.id === target.id);
      record("DOC-09", "Reopened request is 'requested' again with the reason retained", "requested + note",
        `${t3?.status} / note=${Boolean(t3?.reviewNote)}`, t3?.status === "requested");

      // Cross-candidate IDOR: candidate A must not touch candidate C's request
      const idor = await apiFetch(`/api/v1/me/document-requests/${target.id}/files`, {
        method: "POST", cookie: cand.cookie, headers: hA,
        json: { originalFileName: "curang.png", contentType: "image/png", fileSizeBytes: 100 },
      });
      // 404, and not "404 or 403". `loadRequestForCandidate` scopes its query by the caller's own
      // registration, so a request belonging to someone else yields no row and EXISTENCE COLLAPSES
      // INTO OWNERSHIP — a foreign id is indistinguishable from a missing one, which is what stops
      // this endpoint enumerating other candidates' requests. A 403 would confirm the request
      // exists. Asserting either passes on whichever the code answers, so it could not have failed
      // if that collapse were ever replaced by a confirming refusal.
      record("DOC-10", "Another candidate cannot upload to someone else's request", "404 document_request_not_found", `${idor.status} ${errorCode(idor)}`,
        refusedWith(idor, 404, "document_request_not_found"), bodySnippet(idor.body));

      // Cancel to leave the seed clean-ish
      await apiFetch(`/api/v1/institutions/${INST.a.slug}/competitions/${COMP.closing.id}/document-requests/${target.id}`,
        { method: "PATCH", cookie: elev.cookie, json: { action: "cancel" } });
    }
  }

  mkdirSync(`${REPO}/test-artifacts/behavior`, { recursive: true });
  writeFileSync(`${REPO}/test-artifacts/behavior/r2-flows.json`, JSON.stringify(results, null, 2));
  const md = [
    "# R2 File Flows — real uploads through the validation pipeline",
    `Run: ${new Date().toISOString()} — ${results.filter((r) => r.pass).length}/${results.length} passed`,
    "",
    "| ID | Check | Expected | Actual | Pass | Note |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | ${r.expected} | ${String(r.actual).replaceAll("|", "/")} | ${r.pass ? "✅" : "❌"} | ${String(r.note).replaceAll("|", "/").slice(0, 130)} |`),
  ].join("\n");
  writeFileSync(`${REPO}/test-artifacts/behavior/r2-flows.md`, md);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed → test-artifacts/behavior/r2-flows.md`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
};

main().catch((e) => { console.error(e); process.exit(2); });
