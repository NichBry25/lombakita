// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { lookupInstitutionBySlug, lookupUserByEmail } from "./lookup-service";
import type { Database } from "@/server/db/client";

const makeDb = (row: Record<string, unknown> | null) =>
  ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
  }) as unknown as Database;

describe("lookupUserByEmail", () => {
  it("returns null when no user matches", async () => {
    const res = await lookupUserByEmail("missing@example.com", makeDb(null));
    expect(res).toBeNull();
  });

  it("returns the user row on hit", async () => {
    const row = {
      id: "u1",
      email: "a@b.com",
      name: "A",
      appRole: "candidate",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date(),
    };
    const res = await lookupUserByEmail("a@b.com", makeDb(row));
    expect(res?.id).toBe("u1");
  });
});

describe("lookupInstitutionBySlug", () => {
  it("returns null when no institution matches", async () => {
    const res = await lookupInstitutionBySlug("nope", makeDb(null));
    expect(res).toBeNull();
  });

  it("returns the institution row on hit", async () => {
    const row = {
      id: "i1",
      name: "Inst",
      slug: "inst",
      verificationStatus: "verified",
      verifiedAt: new Date(),
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date(),
      ownerEmail: "owner@b.com",
      ownerName: "Owner",
    };
    const res = await lookupInstitutionBySlug("inst", makeDb(row));
    expect(res?.ownerEmail).toBe("owner@b.com");
  });
});
