// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { lookupInstitutionBySlug, lookupInstitutionBySlugOrName, lookupUserByEmail } from "./lookup-service";
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
      displayName: "Inst",
      institutionType: null,
      ownerUsername: null,
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
    expect(res?.name).toBe("Inst");
  });

  it("resolves a personal institution name from the owner username (display_name is NULL)", async () => {
    const row = {
      id: "ip",
      displayName: null,
      institutionType: "personal",
      ownerUsername: "owneruser",
      slug: "owneruser",
      verificationStatus: "pending_verification",
      verifiedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date(),
      ownerEmail: "owner@b.com",
      ownerName: "Owner",
    };
    const res = await lookupInstitutionBySlug("owneruser", makeDb(row));
    expect(res?.name).toBe("owneruser's Institution");
  });
});

describe("F20 — lookupInstitutionBySlugOrName", () => {
  const institutionRow = {
    id: "i2",
    displayName: "Universitas Nusantara",
    institutionType: null,
    ownerUsername: null,
    slug: "universitas-nusantara",
    verificationStatus: "verified",
    verifiedAt: new Date(),
    suspendedAt: null,
    suspensionReason: null,
    createdAt: new Date(),
    ownerEmail: "rektor@nusantara.ac.id",
    ownerName: "Rektor",
  };

  it("returns null when no slug or name matches", async () => {
    const res = await lookupInstitutionBySlugOrName("tidak-ada", makeDb(null));
    expect(res).toBeNull();
  });

  it("resolves when matched by slug", async () => {
    const res = await lookupInstitutionBySlugOrName("universitas-nusantara", makeDb(institutionRow));
    expect(res?.id).toBe("i2");
    expect(res?.slug).toBe("universitas-nusantara");
  });

  it("resolves when matched by display name", async () => {
    const res = await lookupInstitutionBySlugOrName("Universitas Nusantara", makeDb(institutionRow));
    expect(res?.id).toBe("i2");
    expect(res?.name).toBe("Universitas Nusantara");
  });
});
