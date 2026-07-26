// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireAdminInstitutionBySlug, exportRegistrantsAsCsv } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    requireAdminInstitutionBySlug: vi.fn(),
    exportRegistrantsAsCsv: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/participants/export-service", async (importActual) => {
  const actual = await importActual<typeof import("@/server/participants/export-service")>();
  return { ...actual, exportRegistrantsAsCsv };
});

import { GET } from "./route";

const ownerSession = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const makeGet = () =>
  new Request(
    "http://localhost/api/v1/institutions/lk-univ/competitions/comp-1/export/registrants",
    { method: "GET" },
  );

const makeParams = () => ({
  params: Promise.resolve({ institutionSlug: "lk-univ", competitionId: "comp-1" }),
});

describe("GET /api/v1/institutions/[institutionSlug]/competitions/[competitionId]/export/registrants", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns 200 with text/csv header for valid institution_owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });
    exportRegistrantsAsCsv.mockResolvedValue(
      "﻿registration_id,registration_type\nreg_1,individual",
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("registrants-");
    expect(res.headers.get("content-disposition")).toContain(".csv");
  });

  it("(b) returns 200 with header-only CSV when no registrants (empty export)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });
    exportRegistrantsAsCsv.mockResolvedValue(
      "﻿registration_id,registration_type,team_name,is_captain,participant_name,participant_email,registration_status,internal_review_status,has_submission,submission_finalized,registered_at",
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.slice(1).split("\n"); // strip BOM
    expect(lines).toHaveLength(1); // header only, not 404
  });

  it("(c) returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(401);
  });

  it("(d) returns 403 for institution_member (CCR-09)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(403);
  });

  it("(e) returns 404 when the competition does not belong to the institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });
    const { ExportOwnershipError } = await import("@/server/participants/export-service");
    exportRegistrantsAsCsv.mockRejectedValue(new ExportOwnershipError());

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(404);
  });
});
