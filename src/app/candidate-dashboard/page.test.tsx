// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockGetCurrentSession,
  mockGetUnverifiedRoles,
  mockListIndividual,
  mockListTeam,
  mockListSaved,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockGetUnverifiedRoles: vi.fn(),
  mockListIndividual: vi.fn(),
  mockListTeam: vi.fn(),
  mockListSaved: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
// Render a real <a> so renderToStaticMarkup can assert href attributes.
vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href }: { children: unknown; href: string }) =>
      React.createElement("a", { href }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/auth/role-verification", () => ({ getUnverifiedRoles: mockGetUnverifiedRoles }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/candidate-registrations/candidate-registration-service", () => ({
  listCandidateIndividualRegistrations: mockListIndividual,
  listCandidateTeamRegistrations: mockListTeam,
}));
vi.mock("@/server/saved-competitions/saved-competition-service", () => ({
  listSavedCompetitions: mockListSaved,
}));
vi.mock("@/components/auth/second-role-banner", () => ({ SecondRoleBanner: () => null }));

import CandidateDashboardPage from "@/app/candidate-dashboard/page";

// ─── shared fixtures ────────────────────────────────────────────────────────

const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const NOW_TS = new Date("2026-06-01T12:00:00.000Z");

const validSession = {
  user: { id: "u_candidate", email: "c@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const emptySaved = { data: [], meta: { total: 0, page: 1, limit: 5, totalPages: 0 } };

const confirmedIndReg = {
  id: "reg_i1",
  competitionId: "comp_1",
  registrationStatus: "confirmed" as const,
  registeredAt: NOW_TS,
  cancelledAt: null,
  createdAt: NOW_TS,
  competitionTitle: "Hackathon Nasional 2026",
  competitionSlug: "hackathon-2026",
  competitionMode: "individual" as const,
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  eventEndAt: FUTURE,
  institutionSlug: "ui",
};

const cancelledIndReg = {
  ...confirmedIndReg,
  id: "reg_i2",
  registrationStatus: "cancelled" as const,
  cancelledAt: NOW_TS,
  competitionTitle: "Kompetisi Lama",
  competitionSlug: "kompetisi-lama",
};

const captainTeamReg = {
  id: "reg_t1",
  competitionId: "comp_2",
  registrationStatus: "confirmed" as const,
  registeredAt: NOW_TS,
  cancelledAt: null,
  createdAt: NOW_TS,
  competitionTitle: "Battle of Minds",
  competitionSlug: "battle-of-minds",
  competitionMode: "team" as const,
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  eventEndAt: FUTURE,
  institutionSlug: "itb",
  teamId: "team_1",
  teamName: "Regu Alpha",
  teamStatus: "submitted" as const,
  isCaptain: true,
};

const memberTeamReg = {
  ...captainTeamReg,
  id: "reg_t2",
  teamId: "team_2",
  teamName: "Regu Beta",
  isCaptain: false,
};

const savedItem = (n: number, savedStatus: "available" | "unavailable" = "available") => ({
  competitionId: `comp_s${n}`,
  slug: `saved-comp-${n}`,
  title: `Saved Competition ${n}`,
  institutionSlug: "ugm",
  institutionName: "Universitas Gadjah Mada",
  category: null,
  mode: null,
  registrationEndAt: null,
  savedAt: NOW_TS,
  savedStatus,
});

const setupValidCandidate = () => {
  mockGetCurrentSession.mockResolvedValue(validSession);
  mockGetUnverifiedRoles.mockResolvedValue([]);
};

// ─── GUARD TESTS (Steps 9, 10) ──────────────────────────────────────────────

describe("Step 9 & 10 — Session guard redirects", () => {
  afterEach(() => vi.clearAllMocks());

  it("Step 10 — redirects unauthenticated sessions to sign-in", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(CandidateDashboardPage()).rejects.toThrow("NEXT_REDIRECT");
    // F2 (Step 6.5b): unauthenticated guards send users to the login view at /auth/login.
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/auth/login"));
  });

  it("Step 9 — redirects recruiter-only session (unverified candidate) to verify-role", async () => {
    mockGetCurrentSession.mockResolvedValue({
      user: { id: "u_recruiter", email: "r@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetUnverifiedRoles.mockResolvedValue(["candidate"]);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(CandidateDashboardPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/auth/verify-role?as=candidate");
  });
});

// ─── CONTENT RENDERING TESTS (Steps 1, 2, 3, 4, 6, 8, 11) ──────────────────

describe("Content rendering — individual registrations", () => {
  afterEach(() => vi.clearAllMocks());

  it("Step 1 — renders confirmed individual registration with title and Terdaftar status", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([confirmedIndReg]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Hackathon Nasional 2026");
    expect(html).toContain("Terdaftar");
  });

  it("Step 2 — renders cancelled individual registration with Dibatalkan status (not hidden)", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([confirmedIndReg, cancelledIndReg]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Kompetisi Lama");
    expect(html).toContain("Dibatalkan");
    // Confirmed row still present alongside cancelled
    expect(html).toContain("Hackathon Nasional 2026");
  });
});

describe("Content rendering — team registrations", () => {
  afterEach(() => vi.clearAllMocks());

  it("Step 3 — renders Kapten indicator for a captain team registration", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([captainTeamReg]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Regu Alpha");
    expect(html).toContain("Kapten");
  });

  it("Step 4 — renders Anggota indicator for a non-captain member (no Kapten label)", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([memberTeamReg]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Regu Beta");
    expect(html).toContain("Anggota");
    expect(html).not.toContain("Kapten");
  });

  it("Step 3+4 combined — correct indicator per row when both captain and member rows present", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([captainTeamReg, memberTeamReg]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Kapten");
    expect(html).toContain("Anggota");
    expect(html).toContain("Regu Alpha");
    expect(html).toContain("Regu Beta");
  });
});

describe("Saved competitions preview", () => {
  afterEach(() => vi.clearAllMocks());

  it("Step 6 — calls listSavedCompetitions with { limit: 5 } (not { pageSize: 5 })", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue({
      data: Array.from({ length: 5 }, (_, i) => savedItem(i + 1)),
      meta: { total: 6, page: 1, limit: 5, totalPages: 2 },
    });

    await CandidateDashboardPage();

    expect(mockListSaved).toHaveBeenCalledWith("u_candidate", { limit: 5 });
  });

  it("renders unavailable saved item as plain text (no broken link)", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue({
      data: [savedItem(1, "unavailable")],
      meta: { total: 1, page: 1, limit: 5, totalPages: 1 },
    });

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Saved Competition 1");
    expect(html).toContain("Tidak tersedia");
    // unavailable item must not render a link to the competition page
    expect(html).not.toContain('href="/competitions/ugm/saved-comp-1"');
  });

  it("renders 'View all' link targeting /saved exactly", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue({
      data: [savedItem(1)],
      meta: { total: 1, page: 1, limit: 5, totalPages: 1 },
    });

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain('href="/saved"');
  });
});

describe("Step 8 — Empty states", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders all four empty state messages when all services return no data", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Tidak ada tenggat mendatang");
    expect(html).toContain("Belum ada pendaftaran individu");
    expect(html).toContain("Belum ada pendaftaran tim");
    expect(html).toContain("Belum ada kompetisi yang disimpan");
  });
});

describe("Step 11 — Link hrefs", () => {
  afterEach(() => vi.clearAllMocks());

  it("individual registration row: competition link and registration subpage link are correct", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([confirmedIndReg]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain('href="/competitions/ui/hackathon-2026"');
    expect(html).toContain('href="/competitions/ui/hackathon-2026/registration/"');
  });

  it("team registration row: competition link and registration subpage link are correct", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([captainTeamReg]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain('href="/competitions/itb/battle-of-minds"');
    expect(html).toContain('href="/competitions/itb/battle-of-minds/registration/"');
  });

  it("available saved competition renders as a link to its competition page", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue({
      data: [savedItem(1)],
      meta: { total: 1, page: 1, limit: 5, totalPages: 1 },
    });

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain('href="/competitions/ugm/saved-comp-1"');
  });

  it("upcoming deadline section shows future dates from non-cancelled registrations", async () => {
    setupValidCandidate();
    mockListIndividual.mockResolvedValue([confirmedIndReg]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    // Upcoming deadlines section renders the competition title
    expect(html).toContain("Hackathon Nasional 2026");
    // Past-deadline: component uses live new Date() so we can only assert section renders
    expect(html).toContain("Tenggat mendatang");
  });

  it("cancelled registration does not contribute to upcoming deadlines", async () => {
    setupValidCandidate();
    // Only a cancelled reg with future dates — should produce no deadlines
    mockListIndividual.mockResolvedValue([{ ...cancelledIndReg, registrationEndAt: FUTURE }]);
    mockListTeam.mockResolvedValue([]);
    mockListSaved.mockResolvedValue(emptySaved);

    const html = renderToStaticMarkup(await CandidateDashboardPage());

    expect(html).toContain("Tidak ada tenggat mendatang");
  });
});
