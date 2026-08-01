// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn(() => true),
  generatePresignedGetUrl: vi.fn(() => Promise.resolve("https://r2.example/get")),
}));

import {
  SubmissionFileError,
  getSubmissionForInstitution,
  resolveSubmissionFileUrlForInstitution,
} from "@/server/participants/submission-file-service";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";

const NOW = new Date("2026-03-01T09:30:00.000Z");

const submissionRow = (overrides: Record<string, unknown> = {}) => ({
  fileKey: "submissions/reg_a/abc-123",
  fileName: "karya final.pdf",
  fileSizeBytes: 2_097_152,
  fileMimeType: "application/pdf",
  version: 2,
  finalizedAt: NOW,
  submittedAt: NOW,
  participantDisplayName: "Sari Dewi",
  participantUsername: "saridewi",
  teamName: null,
  ...overrides,
});

// select() chains resolve the next `selects` entry, whether awaited directly or via .limit().
// insert() chains record their values() argument so a test can assert the audit row written.
function createDbMock(selects: unknown[][]) {
  const queue = [...selects];
  const insertedValues: Record<string, unknown>[] = [];

  const thenable = (c: Record<string, unknown>, result: unknown) => {
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
  };

  const selectChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.leftJoin = () => c;
    c.where = () => c;
    c.limit = () => Promise.resolve(result);
    thenable(c, result);
    return c;
  };

  const insertChain = () => {
    const c: Record<string, unknown> = {};
    c.values = (values: Record<string, unknown>) => {
      insertedValues.push(values);
      return c;
    };
    thenable(c, []);
    return c;
  };

  const db: Record<string, unknown> = {
    select: () => selectChain(queue.shift() ?? []),
    insert: () => insertChain(),
  };

  return { db: db as never, insertedValues };
}

afterEach(() => {
  vi.mocked(isR2Available).mockReturnValue(true);
  vi.clearAllMocks();
});

// The response-override options bound into the first signed URL of a test.
const firstSignedUrlOptions = () => {
  const [call] = vi.mocked(generatePresignedGetUrl).mock.calls;
  if (!call) throw new Error("generatePresignedGetUrl was never called");
  return call[2];
};

describe("getSubmissionForInstitution", () => {
  it("returns the submission metadata for a competition the institution owns", async () => {
    const { db } = createDbMock([[submissionRow()]]);

    const result = await getSubmissionForInstitution("inst_1", "comp_1", "reg_a", db);

    expect(result).toEqual({
      fileName: "karya final.pdf",
      fileSizeBytes: 2_097_152,
      fileMimeType: "application/pdf",
      version: 2,
      finalized: true,
      submittedAt: NOW.toISOString(),
      canRenderInline: true,
    });
  });

  it("returns null when the ownership join matches nothing", async () => {
    const { db } = createDbMock([[]]);
    expect(await getSubmissionForInstitution("inst_other", "comp_1", "reg_a", db)).toBeNull();
  });

  it("reports a non-renderable type so the UI offers download only", async () => {
    const { db } = createDbMock([
      [submissionRow({ fileMimeType: "application/zip", finalizedAt: null })],
    ]);

    const result = await getSubmissionForInstitution("inst_1", "comp_1", "reg_a", db);

    expect(result?.canRenderInline).toBe(false);
    expect(result?.finalized).toBe(false);
  });
});

describe("resolveSubmissionFileUrlForInstitution", () => {
  it("records who opened the submission before minting the URL", async () => {
    const { db, insertedValues } = createDbMock([[submissionRow()]]);

    const result = await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    );

    expect(result.url).toBe("https://r2.example/get");
    expect(insertedValues[0]).toMatchObject({
      institutionId: "inst_1",
      actorUserId: "actor_1",
      action: "submission.file_accessed",
    });
  });

  it("refuses a registration the institution does not own", async () => {
    const { db, insertedValues } = createDbMock([[]]);

    const error = await resolveSubmissionFileUrlForInstitution(
      "inst_other",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    ).catch((e: unknown) => e as SubmissionFileError);

    expect(error).toBeInstanceOf(SubmissionFileError);
    expect((error as SubmissionFileError).code).toBe("submission_not_found");
    // No audit row for a read that never happened.
    expect(insertedValues).toHaveLength(0);
  });

  it("binds the declared content type only when it is one this app renders inline", async () => {
    const { db } = createDbMock([[submissionRow()]]);

    const result = await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    );

    expect(result.disposition).toBe("inline");
    expect(firstSignedUrlOptions()).toMatchObject({ responseContentType: "application/pdf" });
  });

  // The upload path stores a client-declared MIME type with no magic-byte check, so an inline
  // render of a scriptable type would be stored XSS on the bucket origin. The request for `inline`
  // is downgraded rather than honoured.
  it("downgrades an inline request for a scriptable type to an opaque download", async () => {
    const { db } = createDbMock([[submissionRow({ fileMimeType: "text/html" })]]);

    const result = await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    );

    expect(result.disposition).toBe("attachment");
    const options = firstSignedUrlOptions();
    expect(options).toMatchObject({ responseContentType: "application/octet-stream" });
    expect(String(options?.responseContentDisposition)).toContain("attachment");
  });

  it("downgrades an inline request when no content type was recorded", async () => {
    const { db } = createDbMock([[submissionRow({ fileMimeType: null })]]);

    const result = await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    );

    expect(result.disposition).toBe("attachment");
  });

  it("prefixes the download filename with the participant so files stay distinguishable", async () => {
    const { db } = createDbMock([[submissionRow()]]);

    await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "attachment",
      db,
    );

    const disposition = String(firstSignedUrlOptions()?.responseContentDisposition);
    expect(disposition).toContain("Sari_Dewi_karya_final.pdf");
  });

  it("names a team submission after the team", async () => {
    const { db } = createDbMock([
      [submissionRow({ teamName: "Tim Garuda", participantDisplayName: null })],
    ]);

    await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "attachment",
      db,
    );

    const disposition = String(firstSignedUrlOptions()?.responseContentDisposition);
    expect(disposition).toContain("Tim_Garuda_karya_final.pdf");
  });

  it("degrades to 503 rather than 500 when R2 is unconfigured", async () => {
    vi.mocked(isR2Available).mockReturnValue(false);
    const { db } = createDbMock([[submissionRow()]]);

    const error = await resolveSubmissionFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "comp_1",
      "reg_a",
      "inline",
      db,
    ).catch((e: unknown) => e as SubmissionFileError);

    expect((error as SubmissionFileError).httpStatus).toBe(503);
    expect((error as SubmissionFileError).code).toBe("submission_download_unavailable");
  });
});
