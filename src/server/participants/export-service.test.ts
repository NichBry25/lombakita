// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  CSV_BOM,
  ExportOwnershipError,
  escapeCell,
  exportRegistrantsAsCsv,
  exportSubmissionsAsCsv,
  exportResultsAsCsv,
} from "./export-service";

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function createDbMock(opts: { selects?: unknown[][] }) {
  const selects = [...(opts.selects ?? [])];

  const selectChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.leftJoin = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(result);
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return c;
  };

  return {
    select: () => selectChain(selects.shift() ?? []),
  } as never;
}

// ─── escapeCell ───────────────────────────────────────────────────────────────

describe("escapeCell", () => {
  it("returns plain string unchanged when no special chars", () => {
    expect(escapeCell("hello")).toBe("hello");
    expect(escapeCell("Juara 1")).toBe("Juara 1");
  });

  it("wraps in double-quotes when cell contains a comma", () => {
    expect(escapeCell("a,b")).toBe('"a,b"');
  });

  it("wraps in double-quotes and doubles internal double-quotes", () => {
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("wraps in double-quotes when cell contains a newline", () => {
    expect(escapeCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps in double-quotes when cell contains a carriage return", () => {
    expect(escapeCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("returns empty string for null", () => {
    expect(escapeCell(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(escapeCell(undefined)).toBe("");
  });

  it("converts numbers to string", () => {
    expect(escapeCell(42)).toBe("42");
  });

  it("converts boolean to string", () => {
    expect(escapeCell(true)).toBe("true");
  });
});

// ─── exportRegistrantsAsCsv ───────────────────────────────────────────────────

describe("exportRegistrantsAsCsv", () => {
  it("throws ExportOwnershipError for a cross-institution competition", async () => {
    const db = createDbMock({ selects: [[]] }); // ownership check returns nothing
    await expect(exportRegistrantsAsCsv("inst_1", "comp_other", db)).rejects.toBeInstanceOf(
      ExportOwnershipError,
    );
  });

  it("returns CSV with header row only (BOM included) when no registrants", async () => {
    const db = createDbMock({ selects: [[{ id: "comp_1" }], []] }); // owned, no rows
    const csv = await exportRegistrantsAsCsv("inst_1", "comp_1", db);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("registration_id");
    expect(lines[0]).not.toContain("internal_notes"); // never exposed
  });

  it("returns one data row per registration with correct column count", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [
          {
            registrationId: "reg_1",
            registrationType: "individual",
            teamId: null,
            studentId: "user_1",
            registrationStatus: "confirmed",
            internalReviewStatus: "pending_review",
            registeredAt: new Date("2025-01-01"),
            teamName: null,
            captainId: null,
            participantName: "Budi",
            participantUsername: "budi123",
            participantEmail: "budi@example.com",
            submissionRegistrationId: null,
            submissionFinalizedAt: null,
          },
        ],
      ],
    });
    const csv = await exportRegistrantsAsCsv("inst_1", "comp_1", db);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    const headerCols = lines[0]!.split(",");
    const dataCols = lines[1]!.split(",");
    expect(headerCols).toHaveLength(11);
    expect(dataCols).toHaveLength(11);
    // internal_notes must not appear in any column
    expect(lines[0]).not.toContain("internal_notes");
    expect(lines[1]).not.toContain("internal_notes");
  });
});

// ─── exportSubmissionsAsCsv ───────────────────────────────────────────────────

describe("exportSubmissionsAsCsv", () => {
  it("throws ExportOwnershipError for a cross-institution competition", async () => {
    const db = createDbMock({ selects: [[]] });
    await expect(exportSubmissionsAsCsv("inst_1", "comp_other", db)).rejects.toBeInstanceOf(
      ExportOwnershipError,
    );
  });

  it("returns CSV with header row only when no submissions", async () => {
    const db = createDbMock({ selects: [[{ id: "comp_1" }], []] });
    const csv = await exportSubmissionsAsCsv("inst_1", "comp_1", db);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("registration_id");
  });

  it("returns one row per submission with correct column count", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [
          {
            registrationId: "reg_1",
            participantName: "Ani",
            participantUsername: "ani99",
            fileName: "submission.pdf",
            fileSizeBytes: 12345,
            version: 1,
            finalizedAt: new Date("2025-06-01"),
            submittedAt: new Date("2025-05-30"),
          },
        ],
      ],
    });
    const csv = await exportSubmissionsAsCsv("inst_1", "comp_1", db);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(2);
    const headerCols = lines[0]!.split(",");
    expect(headerCols).toHaveLength(7);
  });
});

// ─── exportResultsAsCsv ───────────────────────────────────────────────────────

describe("exportResultsAsCsv", () => {
  it("throws ExportOwnershipError for a cross-institution competition", async () => {
    const db = createDbMock({ selects: [[]] });
    await expect(exportResultsAsCsv("inst_1", "comp_other", db)).rejects.toBeInstanceOf(
      ExportOwnershipError,
    );
  });

  it("returns CSV with header row only when no results", async () => {
    const db = createDbMock({ selects: [[{ id: "comp_1" }], []] });
    const csv = await exportResultsAsCsv("inst_1", "comp_1", db);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result_label");
  });

  it("returns one row per result with correct column count", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [
          {
            registrationId: "reg_1",
            participantName: "Citra",
            participantUsername: "citra_dev",
            teamName: null,
            resultLabel: "Juara 1",
            resultNotes: null,
            resultStatus: "published",
            publishedAt: new Date("2025-06-01"),
          },
        ],
      ],
    });
    const csv = await exportResultsAsCsv("inst_1", "comp_1", db);
    const lines = csv.slice(CSV_BOM.length).split("\n");
    expect(lines).toHaveLength(2);
    const headerCols = lines[0]!.split(",");
    expect(headerCols).toHaveLength(7);
  });
});
