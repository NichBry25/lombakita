// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const {
  mockIsR2Available,
  mockGeneratePresignedPutUrl,
  mockGeneratePresignedGetUrl,
  mockHeadObject,
  mockReadObjectHead,
  mockDeleteObject,
  mockListObjects,
} = vi.hoisted(() => ({
  mockIsR2Available: vi.fn().mockReturnValue(true),
  mockGeneratePresignedPutUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
  mockGeneratePresignedGetUrl: vi.fn().mockResolvedValue("https://r2.example/get"),
  mockHeadObject: vi.fn(),
  mockReadObjectHead: vi.fn(),
  mockDeleteObject: vi.fn().mockResolvedValue(undefined),
  // Default: nothing under the prefix, so the orphan sweep short-circuits and never touches the db.
  mockListObjects: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: mockIsR2Available,
  generatePresignedPutUrl: mockGeneratePresignedPutUrl,
  generatePresignedGetUrl: mockGeneratePresignedGetUrl,
  headObject: mockHeadObject,
  readObjectHead: mockReadObjectHead,
  deleteObject: mockDeleteObject,
  listObjects: mockListObjects,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));

import {
  sweepOrphanedObjectsForAccount,
  sweepOrphanedSubmissionObjects,
} from "./recruiter-verification-service";

afterEach(() => vi.clearAllMocks());

describe("sweepOrphanedSubmissionObjects", () => {
  // db whose document-key query resolves the referenced r2 keys for the submission.
  const buildSweepDb = (referencedKeys: string[]) => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn().mockResolvedValue(referencedKeys.map((r2Key) => ({ r2Key }))),
    };
    return { select: vi.fn(() => chain) };
  };

  const OLD = new Date(Date.now() - 60 * 60 * 1000); // an hour old — safely past the upload window

  it("deletes objects with no referencing row, keeps referenced ones", async () => {
    const db = buildSweepDb(["recruiter-verification/u_1/sub_1/keep"]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/keep", lastModified: OLD },
      { key: "recruiter-verification/u_1/sub_1/orphan", lastModified: OLD },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never);

    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/orphan");
  });

  it("respects age: does not delete an unreferenced object still inside the upload window", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/in-flight", lastModified: new Date() },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never);

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("terminal sweep (respectAge=false) deletes even a fresh unreferenced object", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/fresh", lastModified: new Date() },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: false }, db as never);

    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/fresh");
  });

  it("never throws when storage listing fails — it is best-effort", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockRejectedValueOnce(new Error("R2 down"));

    await expect(
      sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never),
    ).resolves.toBeUndefined();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("no-ops (no db query) when nothing exists under the prefix", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    // mockListObjects default resolves [].

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: false }, db as never);

    expect(db.select).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

describe("sweepOrphanedObjectsForAccount", () => {
  // db whose editable-submission lookup (.orderBy().limit()) returns `pendingRows` and whose
  // document-key query (awaited after .where) returns `referencedKeys`.
  const buildAccountDb = (pendingRows: Array<{ id: string }>, referencedKeys: string[]) => {
    const referencedRows = referencedKeys.map((r2Key) => ({ r2Key }));
    const whereResult = {
      orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(pendingRows) })),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(referencedRows).then(onFulfilled, onRejected),
    };
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => whereResult) };
    return { select: vi.fn(() => chain) };
  };

  const OLD = new Date(Date.now() - 60 * 60 * 1000);

  it("sweeps the account's editable submission's orphans", async () => {
    const db = buildAccountDb([{ id: "sub_1" }], ["recruiter-verification/u_1/sub_1/keep"]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/keep", lastModified: OLD },
      { key: "recruiter-verification/u_1/sub_1/orphan", lastModified: OLD },
    ]);

    await sweepOrphanedObjectsForAccount("u_1", db as never);

    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/orphan");
  });

  it("no-ops when the account has no editable submission", async () => {
    const db = buildAccountDb([], []);
    mockGetDb.mockReturnValue(db);

    await sweepOrphanedObjectsForAccount("u_1", db as never);

    expect(mockListObjects).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});
