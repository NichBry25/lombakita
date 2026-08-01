// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/async/enqueue", () => ({
  enqueueRegistrationDocumentRequested: vi.fn(() => Promise.resolve({ accepted: true })),
  enqueueRegistrationDocumentReviewed: vi.fn(() => Promise.resolve({ accepted: true })),
}));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn(() => true),
  generatePresignedPutUrl: vi.fn(() => Promise.resolve("https://r2.example/put")),
  generatePresignedGetUrl: vi.fn(() => Promise.resolve("https://r2.example/get")),
  headObject: vi.fn(() => Promise.resolve({ sizeBytes: 1024 })),
  readObjectHead: vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))),
  deleteObject: vi.fn(() => Promise.resolve()),
  listObjects: vi.fn(() => Promise.resolve([])),
}));

import {
  RegistrationDocumentError,
  parseDocumentRequestInput,
} from "@/server/registration-documents/registration-document-core";
import { allowedSourceStatesForVerdict } from "@/lib/registration-documents/request-status";
import {
  createDocumentRequest,
  createDocumentRequestsForRegistrations,
  deleteRequestDocumentFile,
  finalizeRequestDocumentUpload,
  prepareRequestDocumentUpload,
  purgeDocumentsForCompetition,
  resolveRequestFileUrlForInstitution,
  reviewDocumentRequest,
} from "@/server/registration-documents/registration-document-service";
import { enqueueRegistrationDocumentRequested } from "@/server/async/enqueue";
import { competitionDocumentRequestFiles } from "@/server/db/schema";
import { deleteObject, headObject, isR2Available, listObjects } from "@/server/storage/r2.client";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const DUE = new Date("2026-02-14T00:00:00.000Z");

const INPUT = parseDocumentRequestInput(
  { title: "Kartu pelajar", instructions: null, dueAt: DUE.toISOString() },
  NOW,
);

type MockOptions = {
  selects?: unknown[][];
  updates?: unknown[][];
  insertReturns?: unknown[][];
  deleteReturns?: unknown[][];
};

// select() chains resolve the next `selects` entry, whether awaited directly or via .limit().
// insert() chains resolve the next `insertReturns` entry and record their values() argument, so a
// test can assert exactly which rows were written. update() chains resolve the next `updates`
// entry and record their set() argument.
function createDbMock(opts: MockOptions) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const insertReturns = [...(opts.insertReturns ?? [])];
  const deleteReturns = [...(opts.deleteReturns ?? [])];
  const insertedValues: Record<string, unknown>[] = [];
  const updatedSets: Record<string, unknown>[] = [];
  // Which tables a delete() targeted — lets a test assert that a purge emptied the file table and
  // nothing else.
  const deletedTables: unknown[] = [];

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
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(result);
    thenable(c, result);
    return c;
  };
  const updateChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.set = (values: Record<string, unknown>) => {
      updatedSets.push(values);
      return c;
    };
    c.where = () => c;
    c.returning = () => Promise.resolve(result);
    thenable(c, result);
    return c;
  };
  const insertChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.values = (values: Record<string, unknown>) => {
      insertedValues.push(values);
      return c;
    };
    c.returning = () => Promise.resolve(result);
    thenable(c, result);
    return c;
  };
  const deleteChain = (table: unknown, result: unknown[]) => {
    // Records the table object itself rather than a name pulled out of Drizzle's internals, so the
    // assertion compares identity against the imported table and cannot rot with the ORM.
    deletedTables.push(table);
    const c: Record<string, unknown> = {};
    c.where = () => c;
    c.returning = () => Promise.resolve(result);
    thenable(c, result);
    return c;
  };

  const db: Record<string, unknown> = {
    select: () => selectChain(selects.shift() ?? []),
    selectDistinct: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? []),
    insert: () => insertChain(insertReturns.shift() ?? []),
    delete: (table: unknown) => deleteChain(table, deleteReturns.shift() ?? []),
    execute: () => Promise.resolve([]),
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);

  return { db: db as never, insertedValues, updatedSets, deletedTables };
}

const COMPETITION_CONTEXT = [
  {
    title: "Olimpiade Sains",
    displayName: "SMAN 3 Bandung",
    institutionType: "university",
    ownerUsername: "sman3",
  },
];

const catchError = async (fn: () => Promise<unknown>): Promise<RegistrationDocumentError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RegistrationDocumentError) return error;
    throw error;
  }
  throw new Error("expected RegistrationDocumentError to be thrown");
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("allowedSourceStatesForVerdict", () => {
  it("only lets an upload be accepted", () => {
    expect(allowedSourceStatesForVerdict("accept")).toEqual(["submitted"]);
  });

  it("lets a rejection act on an uploaded document as well as on silence", () => {
    // The zero-tolerance case: a document that is present, on time and legible is still
    // refusable. `submitted` must never mean provisionally accepted.
    expect(allowedSourceStatesForVerdict("reject")).toContain("submitted");
    expect(allowedSourceStatesForVerdict("reject")).toContain("requested");
  });
});

describe("createDocumentRequestsForRegistrations", () => {
  it("creates one independent request per participant and never fans out across a team", async () => {
    // Three members of one team, each holding their own registration row. The review service
    // deliberately fans a verdict out across every row sharing a team_id; this must not.
    const { db, insertedValues } = createDbMock({
      selects: [
        COMPETITION_CONTEXT,
        [
          { id: "reg_a", studentId: "u_a" },
          { id: "reg_b", studentId: "u_b" },
          { id: "reg_c", studentId: "u_c" },
        ],
        [],
        [],
        [],
      ],
      insertReturns: [[{ id: "req_a" }], [], [{ id: "req_b" }], [], [{ id: "req_c" }], []],
    });

    const outcome = await createDocumentRequestsForRegistrations(
      "inst_1",
      "comp_1",
      "actor_1",
      ["reg_a", "reg_b", "reg_c"],
      INPUT,
      db,
      NOW,
    );

    expect(outcome.created).toHaveLength(3);
    expect(outcome.skipped).toHaveLength(0);

    const requestRows = insertedValues.filter((row) => "registrationId" in row && "dueAt" in row);
    expect(requestRows.map((row) => row.registrationId)).toEqual(["reg_a", "reg_b", "reg_c"]);
    // Nothing keyed on a team: the request row addresses exactly one registration.
    for (const row of requestRows) {
      expect(row).not.toHaveProperty("teamId");
    }
  });

  it("notifies each targeted participant individually", async () => {
    const { db } = createDbMock({
      selects: [
        COMPETITION_CONTEXT,
        [
          { id: "reg_a", studentId: "u_a" },
          { id: "reg_b", studentId: "u_b" },
        ],
        [],
        [],
      ],
      insertReturns: [[{ id: "req_a" }], [], [{ id: "req_b" }], []],
    });

    await createDocumentRequestsForRegistrations(
      "inst_1",
      "comp_1",
      "actor_1",
      ["reg_a", "reg_b"],
      INPUT,
      db,
      NOW,
    );

    expect(enqueueRegistrationDocumentRequested).toHaveBeenCalledTimes(2);
    const recipients = vi
      .mocked(enqueueRegistrationDocumentRequested)
      .mock.calls.map(([arg]) => arg.userId);
    expect(recipients.sort()).toEqual(["u_a", "u_b"]);
  });

  it("skips a participant who already holds an open request without failing the batch", async () => {
    const { db, insertedValues } = createDbMock({
      selects: [
        COMPETITION_CONTEXT,
        [
          { id: "reg_a", studentId: "u_a" },
          { id: "reg_b", studentId: "u_b" },
        ],
        [{ id: "req_existing" }],
        [],
      ],
      insertReturns: [[{ id: "req_b" }], []],
    });

    const outcome = await createDocumentRequestsForRegistrations(
      "inst_1",
      "comp_1",
      "actor_1",
      ["reg_a", "reg_b"],
      INPUT,
      db,
      NOW,
    );

    expect(outcome.skipped).toEqual([{ registrationId: "reg_a", reason: "already_open" }]);
    expect(outcome.created).toEqual([{ requestId: "req_b", registrationId: "reg_b" }]);
    expect(insertedValues.filter((row) => "dueAt" in row)).toHaveLength(1);
  });

  it("skips a registration that belongs to a different competition", async () => {
    const { db } = createDbMock({
      selects: [COMPETITION_CONTEXT, []],
    });

    const outcome = await createDocumentRequestsForRegistrations(
      "inst_1",
      "comp_1",
      "actor_1",
      ["reg_other"],
      INPUT,
      db,
      NOW,
    );

    expect(outcome.created).toHaveLength(0);
    expect(outcome.skipped).toEqual([
      { registrationId: "reg_other", reason: "not_in_competition" },
    ]);
  });

  it("refuses a competition the institution does not own", async () => {
    const { db } = createDbMock({ selects: [[]] });
    const error = await catchError(() =>
      createDocumentRequestsForRegistrations(
        "inst_other",
        "comp_1",
        "actor_1",
        ["reg_a"],
        INPUT,
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_not_found");
    expect(error.httpStatus).toBe(404);
  });

  it("writes an audit row alongside each created request", async () => {
    const { db, insertedValues } = createDbMock({
      selects: [COMPETITION_CONTEXT, [{ id: "reg_a", studentId: "u_a" }], []],
      insertReturns: [[{ id: "req_a" }], []],
    });

    await createDocumentRequestsForRegistrations(
      "inst_1",
      "comp_1",
      "actor_1",
      ["reg_a"],
      INPUT,
      db,
      NOW,
    );

    const audit = insertedValues.find((row) => row.action === "document_request.created");
    expect(audit).toMatchObject({ institutionId: "inst_1", actorUserId: "actor_1" });
  });
});

describe("createDocumentRequest (single participant)", () => {
  it("reports an existing open request as a conflict rather than a silent skip", async () => {
    const { db } = createDbMock({
      selects: [COMPETITION_CONTEXT, [{ id: "reg_a", studentId: "u_a" }], [{ id: "req_open" }]],
    });

    const error = await catchError(() =>
      createDocumentRequest("inst_1", "comp_1", "actor_1", "reg_a", INPUT, db, NOW),
    );
    expect(error.code).toBe("document_request_already_open");
    expect(error.httpStatus).toBe(409);
  });
});

describe("reviewDocumentRequest", () => {
  const foundRequest = [
    {
      id: "req_1",
      registrationId: "reg_a",
      competitionId: "comp_1",
      title: "Kartu pelajar",
      instructions: null,
      dueAt: DUE,
      status: "submitted",
      submittedAt: NOW,
      reviewedAt: null,
      reviewNote: null,
      revisionCount: 0,
      createdAt: NOW,
      candidateUserId: "u_a",
    },
  ];

  const reviewedRow = (overrides: Record<string, unknown> = {}) => [
    {
      id: "req_1",
      registrationId: "reg_a",
      competitionId: "comp_1",
      title: "Kartu pelajar",
      instructions: null,
      dueAt: DUE,
      status: "accepted",
      submittedAt: NOW,
      reviewedAt: NOW,
      reviewNote: null,
      revisionCount: 0,
      createdAt: NOW,
      ...overrides,
    },
  ];

  it("accepts an uploaded document", async () => {
    const { db, updatedSets } = createDbMock({
      selects: [foundRequest, COMPETITION_CONTEXT, []],
      updates: [reviewedRow()],
      insertReturns: [[]],
    });

    const result = await reviewDocumentRequest(
      "inst_1",
      "actor_1",
      "req_1",
      { verdict: "accept", note: null },
      db,
      NOW,
    );

    expect(result.status).toBe("accepted");
    expect(updatedSets[0]).toMatchObject({ status: "accepted", reviewedByUserId: "actor_1" });
  });

  it("rejects an uploaded document outright when re-upload is not allowed", async () => {
    // Zero tolerance: a file is present and sound, and the verdict is still a refusal.
    const { db, updatedSets } = createDbMock({
      selects: [foundRequest, COMPETITION_CONTEXT, []],
      updates: [reviewedRow({ status: "rejected", reviewNote: "Dokumen dipalsukan." })],
      insertReturns: [[]],
    });

    const result = await reviewDocumentRequest(
      "inst_1",
      "actor_1",
      "req_1",
      { verdict: "reject", note: "Dokumen dipalsukan.", allowReupload: false },
      db,
      NOW,
    );

    expect(result.status).toBe("rejected");
    expect(updatedSets[0]).toMatchObject({ status: "rejected", reviewNote: "Dokumen dipalsukan." });
    expect(updatedSets[0]).not.toHaveProperty("revisionCount");
  });

  it("reopens the request for another attempt, keeping the reason and counting the revision", async () => {
    const nextDue = new Date("2026-02-20T00:00:00.000Z");
    const { db, updatedSets } = createDbMock({
      selects: [foundRequest, COMPETITION_CONTEXT, []],
      updates: [reviewedRow({ status: "requested", reviewNote: "Foto buram.", submittedAt: null })],
      insertReturns: [[]],
    });

    const result = await reviewDocumentRequest(
      "inst_1",
      "actor_1",
      "req_1",
      { verdict: "reject", note: "Foto buram.", allowReupload: true, dueAt: nextDue },
      db,
      NOW,
    );

    expect(result.status).toBe("requested");
    expect(updatedSets[0]).toMatchObject({
      status: "requested",
      reviewNote: "Foto buram.",
      dueAt: nextDue,
      submittedAt: null,
    });
    expect(updatedSets[0]).toHaveProperty("revisionCount");
  });

  it("returns a conflict when the request has already been decided", async () => {
    const { db } = createDbMock({
      selects: [foundRequest, COMPETITION_CONTEXT],
      updates: [[]],
    });

    const error = await catchError(() =>
      reviewDocumentRequest(
        "inst_1",
        "actor_1",
        "req_1",
        { verdict: "accept", note: null },
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_wrong_status");
    expect(error.httpStatus).toBe(409);
  });

  it("refuses a request belonging to another institution", async () => {
    const { db } = createDbMock({ selects: [[]] });
    const error = await catchError(() =>
      reviewDocumentRequest(
        "inst_other",
        "actor_1",
        "req_1",
        { verdict: "accept", note: null },
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_not_found");
  });
});

describe("resolveRequestFileUrlForInstitution", () => {
  it("records who opened the document before minting the URL", async () => {
    const { db, insertedValues } = createDbMock({
      selects: [
        [
          {
            id: "req_1",
            registrationId: "reg_a",
            title: "Kartu pelajar",
            instructions: null,
            dueAt: DUE,
            status: "submitted",
            submittedAt: NOW,
            reviewedAt: null,
            reviewNote: null,
            revisionCount: 0,
            createdAt: NOW,
            competitionId: "comp_1",
            candidateUserId: "u_a",
          },
        ],
        [
          {
            r2Key: "registration-documents/comp_1/reg_a/req_1/f",
            originalFileName: "kartu.jpg",
            contentType: "image/jpeg",
          },
        ],
      ],
    });

    const result = await resolveRequestFileUrlForInstitution(
      "inst_1",
      "actor_1",
      "req_1",
      "file_1",
      "inline",
      db,
    );

    expect(result.url).toBe("https://r2.example/get");
    expect(insertedValues[0]).toMatchObject({
      institutionId: "inst_1",
      actorUserId: "actor_1",
      action: "document_request.file_accessed",
    });
  });
});

describe("prepareRequestDocumentUpload", () => {
  const openRequest = [
    {
      id: "req_1",
      registrationId: "reg_a",
      competitionId: "comp_1",
      title: "Kartu pelajar",
      instructions: null,
      dueAt: DUE,
      status: "requested",
      submittedAt: null,
      reviewedAt: null,
      reviewNote: null,
      revisionCount: 0,
      createdAt: NOW,
    },
  ];

  it("returns a presigned URL scoped to the request", async () => {
    const { db } = createDbMock({ selects: [openRequest, []] });
    const result = await prepareRequestDocumentUpload(
      "u_a",
      "req_1",
      { originalFileName: "kartu.jpg", contentType: "image/jpeg", fileSizeBytes: 1024 },
      db,
    );
    expect(result.r2Key.startsWith("registration-documents/comp_1/reg_a/req_1/")).toBe(true);
  });

  it("rejects a file whose extension disagrees with its declared type", async () => {
    const { db } = createDbMock({ selects: [openRequest] });
    const error = await catchError(() =>
      prepareRequestDocumentUpload(
        "u_a",
        "req_1",
        { originalFileName: "kartu.jpg", contentType: "application/pdf", fileSizeBytes: 1024 },
        db,
      ),
    );
    expect(error.code).toBe("document_request_file_type_not_allowed");
  });

  it("rejects a file beyond the size cap", async () => {
    const { db } = createDbMock({ selects: [openRequest] });
    const error = await catchError(() =>
      prepareRequestDocumentUpload(
        "u_a",
        "req_1",
        {
          originalFileName: "kartu.jpg",
          contentType: "image/jpeg",
          fileSizeBytes: 11 * 1024 * 1024,
        },
        db,
      ),
    );
    expect(error.code).toBe("document_request_file_too_large");
  });

  it("refuses to upload against a closed request", async () => {
    const { db } = createDbMock({
      selects: [[{ ...openRequest[0], status: "rejected" }]],
    });
    const error = await catchError(() =>
      prepareRequestDocumentUpload(
        "u_a",
        "req_1",
        { originalFileName: "kartu.jpg", contentType: "image/jpeg", fileSizeBytes: 1024 },
        db,
      ),
    );
    expect(error.code).toBe("document_request_wrong_status");
  });

  it("refuses a request that belongs to another candidate", async () => {
    const { db } = createDbMock({ selects: [[]] });
    const error = await catchError(() =>
      prepareRequestDocumentUpload(
        "u_other",
        "req_1",
        { originalFileName: "kartu.jpg", contentType: "image/jpeg", fileSizeBytes: 1024 },
        db,
      ),
    );
    expect(error.code).toBe("document_request_not_found");
  });
});

describe("finalizeRequestDocumentUpload", () => {
  const openRequest = [
    {
      id: "req_1",
      registrationId: "reg_a",
      competitionId: "comp_1",
      title: "Kartu pelajar",
      instructions: null,
      dueAt: DUE,
      status: "requested",
      submittedAt: null,
      reviewedAt: null,
      reviewNote: null,
      revisionCount: 0,
      createdAt: NOW,
    },
  ];

  it("refuses a key that is not scoped to the caller's own request", async () => {
    const { db } = createDbMock({ selects: [openRequest] });
    const error = await catchError(() =>
      finalizeRequestDocumentUpload(
        "u_a",
        "req_1",
        { r2Key: "registration-documents/reg_other/req_9/f", originalFileName: "kartu.jpg" },
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_file_invalid");
  });

  it("deletes the object and writes no row when the bytes are not an accepted type", async () => {
    // The magic bytes say JPEG; the filename claims PDF, so extension and content disagree.
    const { db, insertedValues } = createDbMock({ selects: [openRequest] });
    const error = await catchError(() =>
      finalizeRequestDocumentUpload(
        "u_a",
        "req_1",
        { r2Key: "registration-documents/comp_1/reg_a/req_1/f", originalFileName: "kartu.pdf" },
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_file_invalid");
    expect(deleteObject).toHaveBeenCalledWith("registration-documents/comp_1/reg_a/req_1/f");
    expect(insertedValues).toHaveLength(0);
  });

  it("stores the detected content type rather than the client's claim", async () => {
    const { db, insertedValues } = createDbMock({
      selects: [openRequest, []],
      insertReturns: [[{ id: "file_1" }]],
      updates: [[]],
    });

    await finalizeRequestDocumentUpload(
      "u_a",
      "req_1",
      { r2Key: "registration-documents/comp_1/reg_a/req_1/f", originalFileName: "kartu.jpg" },
      db,
      NOW,
    );

    expect(insertedValues[0]).toMatchObject({
      requestId: "req_1",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
    });
  });

  it("refuses a file missing from storage", async () => {
    vi.mocked(headObject).mockResolvedValueOnce(null as never);
    const { db } = createDbMock({ selects: [openRequest] });
    const error = await catchError(() =>
      finalizeRequestDocumentUpload(
        "u_a",
        "req_1",
        { r2Key: "registration-documents/comp_1/reg_a/req_1/f", originalFileName: "kartu.jpg" },
        db,
        NOW,
      ),
    );
    expect(error.code).toBe("document_request_file_not_found");
  });
});

describe("deleteRequestDocumentFile", () => {
  const fileRow = (status: string) => [
    {
      id: "file_1",
      r2Key: "registration-documents/comp_1/reg_a/req_1/f",
      requestId: "req_1",
      status,
    },
  ];

  it("lets the candidate swap a file while the request is still open", async () => {
    const { db } = createDbMock({ selects: [fileRow("requested"), [{ id: "file_2" }]] });
    await expect(deleteRequestDocumentFile("u_a", "file_1", db, NOW)).resolves.toBeUndefined();
    expect(deleteObject).toHaveBeenCalledWith("registration-documents/comp_1/reg_a/req_1/f");
  });

  it("freezes the file once accepted — a record the organizer accepted cannot be withdrawn", async () => {
    const { db } = createDbMock({ selects: [fileRow("accepted")] });
    const error = await catchError(() => deleteRequestDocumentFile("u_a", "file_1", db, NOW));
    expect(error.code).toBe("document_request_wrong_status");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("freezes the file after a closing rejection, where it is the evidence", async () => {
    const { db } = createDbMock({ selects: [fileRow("rejected")] });
    const error = await catchError(() => deleteRequestDocumentFile("u_a", "file_1", db, NOW));
    expect(error.code).toBe("document_request_wrong_status");
  });

  it("returns the request to awaiting-upload when its last file is removed", async () => {
    const { db, updatedSets } = createDbMock({ selects: [fileRow("submitted"), []] });
    await deleteRequestDocumentFile("u_a", "file_1", db, NOW);
    expect(updatedSets[0]).toMatchObject({ status: "requested", submittedAt: null });
  });

  it("leaves the request awaiting review while other files remain", async () => {
    const { db, updatedSets } = createDbMock({
      selects: [fileRow("submitted"), [{ id: "file_2" }]],
    });
    await deleteRequestDocumentFile("u_a", "file_1", db, NOW);
    expect(updatedSets).toHaveLength(0);
  });

  it("refuses a file belonging to another candidate", async () => {
    const { db } = createDbMock({ selects: [[]] });
    const error = await catchError(() => deleteRequestDocumentFile("u_other", "file_1", db, NOW));
    expect(error.code).toBe("document_request_file_not_found");
  });
});

describe("purgeDocumentsForCompetition", () => {
  it("deletes by storage prefix, so abandoned uploads go with the referenced ones", async () => {
    // The second object has no file row — an upload that was PUT and never finalized. Deleting
    // from the row set would have left it behind forever.
    vi.mocked(listObjects).mockResolvedValueOnce([
      { key: "registration-documents/comp_1/reg_a/req_1/f1", lastModified: NOW, size: 10 },
      { key: "registration-documents/comp_1/reg_b/req_2/orphan", lastModified: NOW, size: 10 },
    ] as never);

    const { db } = createDbMock({
      selects: [[{ id: "req_1" }, { id: "req_2" }]],
      deleteReturns: [[{ id: "file_1" }]],
    });

    const outcome = await purgeDocumentsForCompetition("comp_1", db);

    expect(outcome.objectsDeleted).toBe(2);
    expect(outcome.fileRowsDeleted).toBe(1);
    expect(listObjects).toHaveBeenCalledWith("registration-documents/comp_1/");
    expect(deleteObject).toHaveBeenCalledWith("registration-documents/comp_1/reg_a/req_1/f1");
    expect(deleteObject).toHaveBeenCalledWith("registration-documents/comp_1/reg_b/req_2/orphan");
  });

  it("leaves the request rows standing — the verdict outlives the document", async () => {
    vi.mocked(listObjects).mockResolvedValueOnce([
      { key: "registration-documents/comp_1/reg_a/req_1/f1", lastModified: NOW, size: 10 },
    ] as never);

    const { db, deletedTables } = createDbMock({
      selects: [[{ id: "req_1" }]],
      deleteReturns: [[{ id: "file_1" }]],
    });

    await purgeDocumentsForCompetition("comp_1", db);

    // Only the file table is emptied. The request row keeps title, verdict, reviewer and
    // timestamps, so "was this participant verified, by whom, when" stays answerable.
    expect(deletedTables).toEqual([competitionDocumentRequestFiles]);
  });

  it("is a no-op on a competition that collected nothing", async () => {
    vi.mocked(listObjects).mockResolvedValueOnce([] as never);
    const { db } = createDbMock({ selects: [[]] });

    const outcome = await purgeDocumentsForCompetition("comp_empty", db);

    expect(outcome).toEqual({ objectsDeleted: 0, fileRowsDeleted: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("refuses to run when storage is unavailable rather than reporting a false purge", async () => {
    vi.mocked(isR2Available).mockReturnValueOnce(false);
    const { db } = createDbMock({});
    const error = await catchError(() => purgeDocumentsForCompetition("comp_1", db));
    expect(error.code).toBe("document_request_storage_unavailable");
  });
});
