// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/institution-verification/verification-email", () => ({
  sendInstitutionVerifiedEmail: vi.fn(async () => {}),
  sendInstitutionRejectedEmail: vi.fn(async () => {}),
}));

import { VerificationError } from "./verification-core";
import { listInstitutionsForPlatformOps, verifyInstitution } from "./verification-service";

// ─── Condition inspection ─────────────────────────────────────────────────────

// Flattens a drizzle condition into the strings it is built from: column names, SQL operator
// fragments, and bound parameter values. Lets a test prove WHICH predicate a query carries
// without a live database. Same technique as the Fix-C guard tests in institution-service.test.ts.
const flattenCondition = (condition: unknown): string => {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") {
      parts.push(String(node));
      return;
    }

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      record.queryChunks.forEach(walk);
      return;
    }
    // A Column carries the physical column name; a Param/StringChunk carries `value`.
    if (typeof record.name === "string") parts.push(record.name);
    if (record.value !== undefined) walk(record.value);
  };

  walk(condition);
  return parts.join(" ");
};

// ─── DB mocks ─────────────────────────────────────────────────────────────────

// Records every condition passed to .where(), in call order. listInstitutionsForPlatformOps
// issues the page query first, then the count query.
const makeListDb = (rows: unknown[], count: number) => {
  const capturedWhere: unknown[] = [];

  const node = (result: unknown[]): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    n.from = () => n;
    n.where = (condition: unknown) => {
      capturedWhere.push(condition);
      return n;
    };
    n.orderBy = () => n;
    n.limit = () => n;
    n.offset = () => Promise.resolve(result);
    n.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return n;
  };

  let call = 0;
  const db = {
    select: () => node(call++ === 0 ? rows : [{ count }]),
  } as never;

  return { db, capturedWhere };
};

const institutionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "inst_1",
  displayName: "Universitas Contoh",
  institutionType: "university",
  ownerUsername: "owner_satu",
  slug: "universitas-contoh",
  verificationStatus: "pending_verification",
  verifiedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  adminEmail: "owner@contoh.ac.id",
  ...overrides,
});

// ─── listInstitutionsForPlatformOps ───────────────────────────────────────────

describe("listInstitutionsForPlatformOps — personal institutions excluded", () => {
  it("constrains institution_type away from 'personal' when no status filter is given", async () => {
    const { db, capturedWhere } = makeListDb([institutionRow()], 1);

    await listInstitutionsForPlatformOps({ actorRole: "platform_ops", db });

    const pageWhere = flattenCondition(capturedWhere[0]);
    expect(pageWhere).toContain("institution_type");
    expect(pageWhere).toContain("personal");
  });

  it("applies the same predicate to the count query so the total matches the rows", async () => {
    // A mismatch here is the classic pagination bug: rows filtered, total not, leaving a last
    // page of nothing and an inflated "N institusi" header.
    const { db, capturedWhere } = makeListDb([institutionRow()], 1);

    await listInstitutionsForPlatformOps({ actorRole: "platform_ops", db });

    expect(capturedWhere).toHaveLength(2);
    expect(capturedWhere[0]).toBe(capturedWhere[1]);
  });

  it("keeps the personal exclusion when a status filter is also applied", async () => {
    const { db, capturedWhere } = makeListDb([], 0);

    await listInstitutionsForPlatformOps({
      actorRole: "platform_ops",
      statusFilter: "verified",
      db,
    });

    const pageWhere = flattenCondition(capturedWhere[0]);
    expect(pageWhere).toContain("personal");
    expect(pageWhere).toContain("verification_status");
    expect(pageWhere).toContain("verified");
  });

  it("still refuses a non-platform_ops actor before touching the database", async () => {
    const { db, capturedWhere } = makeListDb([], 0);

    await expect(
      listInstitutionsForPlatformOps({ actorRole: "recruiter", db }),
    ).rejects.toMatchObject({ status: 403 });
    expect(capturedWhere).toHaveLength(0);
  });
});

// ─── verifyInstitution ────────────────────────────────────────────────────────

describe("verifyInstitution — personal institutions are not reviewable", () => {
  const makeVerifyDb = (currentRows: unknown[]) => {
    const writes = { updates: 0, inserts: 0 };

    const selectNode = (result: unknown[]): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy"]) n[method] = () => n;
      n.limit = () => Promise.resolve(result);
      n.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return n;
    };

    const selects = [currentRows, []];
    let call = 0;

    const db: Record<string, unknown> = {
      select: () => selectNode(selects[call++] ?? []),
      update: () => {
        writes.updates += 1;
        return {
          set: () => ({
            where: () => ({
              returning: () =>
                Promise.resolve([
                  {
                    id: "inst_1",
                    verificationStatus: "verified",
                    verifiedAt: new Date(),
                    rejectedAt: null,
                    rejectionReason: null,
                  },
                ]),
            }),
          }),
        };
      },
      insert: () => {
        writes.inserts += 1;
        return {
          values: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: "audit_1",
                  actorUserId: "ops_1",
                  fromStatus: "under_review",
                  toStatus: "verified",
                  reason: null,
                  createdAt: new Date(),
                },
              ]),
          }),
        };
      },
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);

    return { db: db as never, writes };
  };

  it("refuses a personal institution with 409 institution_verification_not_applicable", async () => {
    const { db, writes } = makeVerifyDb([
      {
        id: "inst_personal",
        displayName: null,
        institutionType: "personal",
        verificationStatus: "pending_verification",
      },
    ]);

    const error = await verifyInstitution({
      institutionId: "inst_personal",
      targetStatus: "under_review",
      actorUserId: "ops_1",
      actorRole: "platform_ops",
      db,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VerificationError);
    expect(error).toMatchObject({
      code: "institution_verification_not_applicable",
      status: 409,
    });
    // The refusal must land before any write: a hidden row that still accepted a transition
    // would leave a status change and an audit entry describing a review that cannot exist.
    expect(writes.updates).toBe(0);
    expect(writes.inserts).toBe(0);
  });

  it("refuses a personal institution even on an otherwise-valid transition pair", async () => {
    // under_review → verified is a legal edge. The type guard runs first, so the pair never
    // gets a chance to make a personal institution reviewable.
    const { db, writes } = makeVerifyDb([
      {
        id: "inst_personal",
        displayName: null,
        institutionType: "personal",
        verificationStatus: "under_review",
      },
    ]);

    await expect(
      verifyInstitution({
        institutionId: "inst_personal",
        targetStatus: "verified",
        actorUserId: "ops_1",
        actorRole: "platform_ops",
        db,
      }),
    ).rejects.toMatchObject({ code: "institution_verification_not_applicable" });
    expect(writes.updates).toBe(0);
  });

  it("still verifies a full institution — the guard is type-scoped, not a blanket block", async () => {
    const { db, writes } = makeVerifyDb([
      {
        id: "inst_1",
        displayName: "Universitas Contoh",
        institutionType: "university",
        verificationStatus: "under_review",
      },
    ]);

    const result = await verifyInstitution({
      institutionId: "inst_1",
      targetStatus: "verified",
      actorUserId: "ops_1",
      actorRole: "platform_ops",
      db,
    });

    expect(result.institution.verificationStatus).toBe("verified");
    expect(result.auditEntry.toStatus).toBe("verified");
    expect(writes.updates).toBe(1);
    expect(writes.inserts).toBe(1);
  });
});
