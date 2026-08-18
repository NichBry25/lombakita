// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/competitions/competition-public-service", () => ({
  getPublicCompetitionDetail: vi.fn(),
}));

import { GET } from "./route";

const makeDetail = (overrides = {}) => ({
  id: "comp_1",
  slug: "lomba-x",
  title: "Lomba X",
  description: "Deskripsi",
  category: "hackathon" as const,
  mode: "individual" as const,
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: null,
  registrationEndAt: null,
  eventStartAt: null,
  eventEndAt: null,
  resultAnnouncementAt: null,
  minimumParticipantEntries: null,
  participantConfirmationAt: null,
  participationConfirmedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  participantEntryCount: 0,
  participationState: "not_configured" as const,
  feeAmount: null,
  feeCurrency: null,
  eligibilityNote: null,
  tags: [],
  publishedAt: new Date("2026-05-01"),
  registrantCount: 0,
  prizes: [],
  prizePoolTotal: null,
  rounds: [],
  organizer: {
    slug: "lk-univ",
    name: "Universitas LK",
    logoUrl: null,
    about: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    websiteUrl: null,
    socialLinks: [],
  },
  ctaState: "closed" as const,
  phase: "registration_closed" as const,
  ...overrides,
});

const makeRequest = () =>
  new Request("http://localhost/api/v1/competitions/public/lk-univ/lomba-x");

const makeContext = (institutionSlug = "lk-univ", slug = "lomba-x") => ({
  params: Promise.resolve({ institutionSlug, slug }),
});

describe("GET /api/v1/competitions/public/[institutionSlug]/[slug]", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with competition detail for a published slug", async () => {
    const { getPublicCompetitionDetail } =
      await import("@/server/competitions/competition-public-service");
    vi.mocked(getPublicCompetitionDetail).mockResolvedValue(makeDetail());

    const res = await GET(makeRequest() as never, makeContext());
    const body = (await res.json()) as { competition: ReturnType<typeof makeDetail> };

    expect(res.status).toBe(200);
    expect(body.competition.id).toBe("comp_1");
    expect(body.competition.organizer.slug).toBe("lk-univ");
    expect(body.competition.ctaState).toBe("closed");
  });

  it("returns 404 for a draft or nonexistent slug", async () => {
    const { getPublicCompetitionDetail } =
      await import("@/server/competitions/competition-public-service");
    vi.mocked(getPublicCompetitionDetail).mockResolvedValue(null);

    const res = await GET(makeRequest() as never, makeContext());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("competition_not_found");
  });

  it("does not expose status, institutionId, createdAt, or updatedAt", async () => {
    const { getPublicCompetitionDetail } =
      await import("@/server/competitions/competition-public-service");
    vi.mocked(getPublicCompetitionDetail).mockResolvedValue(makeDetail());

    const res = await GET(makeRequest() as never, makeContext());
    const body = (await res.json()) as Record<string, unknown>;

    const comp = body.competition as Record<string, unknown>;
    expect(comp.status).toBeUndefined();
    expect(comp.institutionId).toBeUndefined();
    expect(comp.createdAt).toBeUndefined();
    expect(comp.updatedAt).toBeUndefined();
  });
});
