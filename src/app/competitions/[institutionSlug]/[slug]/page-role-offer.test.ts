// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicCompetitionDetail } from "@/server/competitions/competition-public-service";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  competition: vi.fn(),
  listCompetitions: vi.fn(),
  reviewSummary: vi.fn(),
  reviews: vi.fn(),
  verificationSummary: vi.fn(),
  isHost: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ getCurrentSession: mocks.session }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  getPublicCompetitionDetail: mocks.competition,
  listPublicCompetitions: mocks.listCompetitions,
}));
vi.mock("@/server/competitions/competition-reviews-service", () => ({
  getMyReview: vi.fn(),
  getReviewSummary: mocks.reviewSummary,
  hasConfirmedRegistration: vi.fn(),
  listPublicReviews: mocks.reviews,
}));
vi.mock("@/server/saved-competitions/saved-competition-service", () => ({
  isSavedCompetition: vi.fn(),
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  loadInstitutionVerificationSummaryBySlug: mocks.verificationSummary,
}));
vi.mock("@/server/competitions/competition-access", () => ({
  isCompetitionHost: mocks.isHost,
}));
// DetailActions reads the toast context, which this server render has no provider for.
vi.mock("./detail-actions", () => ({ DetailActions: () => null }));
vi.mock("./save-button", () => ({ SaveButton: () => null }));

import CompetitionDetailPage from "./page";

const COMPETITION: PublicCompetitionDetail = {
  id: "competition-1",
  slug: "lomba-1",
  title: "Lomba Desain Poster",
  description: "Lomba desain poster untuk pelajar dan mahasiswa.",
  category: null,
  mode: null,
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
  participationState: "not_configured",
  feeAmount: null,
  feeCurrency: null,
  eligibilityNote: null,
  organizerContact: null,
  tags: [],
  publishedAt: null,
  registrantCount: 0,
  prizes: [],
  prizePoolTotal: null,
  rounds: [],
  organizer: {
    slug: "acme",
    name: "Acme",
    logoUrl: null,
    about: null,
    websiteUrl: null,
    socialLinks: [],
  },
  ctaState: "open",
  phase: "registration_open",
};

const OFFER_HREF =
  'href="/auth/verify-role?as=candidate&amp;callbackUrl=%2Fcompetitions%2Facme%2Flomba-1"';

const renderPageFor = async (role: string, verifiedRoles: string[]): Promise<string> => {
  mocks.session.mockResolvedValueOnce({ user: { id: "user-42", role, verifiedRoles } });
  const element = await CompetitionDetailPage({
    params: Promise.resolve({ institutionSlug: "acme", slug: "lomba-1" }),
  });
  return renderToStaticMarkup(element);
};

const roleOfferIn = (html: string) => ({
  rolePageLinks: html.split("/auth/verify-role").length - 1,
  offerLinks: html.split(OFFER_HREF).length - 1,
  onlyCandidatesNote: html.includes("Hanya akun kandidat yang dapat mendaftar."),
});

const roleOfferSeenBy = async (role: string) => ({
  withCandidate: roleOfferIn(await renderPageFor(role, ["candidate"])),
  withNone: roleOfferIn(await renderPageFor(role, [])),
});

beforeEach(() => {
  mocks.competition.mockResolvedValue(COMPETITION);
  mocks.listCompetitions.mockResolvedValue({ data: [] });
  mocks.reviewSummary.mockResolvedValue({ count: 0, average: null });
  mocks.reviews.mockResolvedValue([]);
  mocks.verificationSummary.mockResolvedValue(null);
  mocks.isHost.mockReset();
  mocks.isHost.mockResolvedValue(false);
});

describe("the competition page's offer of the participant role", () => {
  it("offers an operational account no participant role page", async () => {
    const seen = {
      platform_ops: await roleOfferSeenBy("platform_ops"),
      finance_ops: await roleOfferSeenBy("finance_ops"),
      reviewer_or_judge: await roleOfferSeenBy("reviewer_or_judge"),
    };
    const noOffer = { rolePageLinks: 0, offerLinks: 0, onlyCandidatesNote: true };

    expect(seen).toEqual({
      platform_ops: { withCandidate: noOffer, withNone: noOffer },
      finance_ops: { withCandidate: noOffer, withNone: noOffer },
      reviewer_or_judge: { withCandidate: noOffer, withNone: noOffer },
    });
  });

  it("offers a host the participant role page from both register buttons", async () => {
    const html = await renderPageFor("recruiter", ["recruiter"]);

    expect(roleOfferIn(html)).toEqual({
      rolePageLinks: 2,
      offerLinks: 2,
      onlyCandidatesNote: false,
    });
  });
});

const HOST_NOTE =
  "Anda pemilik atau staf penyelenggara kompetisi ini, jadi tidak dapat ikut mendaftar.";

const registerSurfaceIn = (html: string) => ({
  registerControls: html.split("Daftar kompetisi").length - 1,
  rolePageLinks: html.split("/auth/verify-role").length - 1,
  registrationLinks: html.split('/lomba-1/registration"').length - 1,
  stickyBars: html.split("register-sticky-bar").length - 1,
  hostNotes: html.split(HOST_NOTE).length - 1,
  reviewInvitations: html.split("Daftar dan ikuti kompetisi ini untuk memberi ulasan.").length - 1,
});

describe("the competition page for the owner and staff of its institution", () => {
  it("offers its owner and staff no register control and no role page, and says why", async () => {
    mocks.isHost.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const seen = {
      hostWithoutCandidateRole: registerSurfaceIn(await renderPageFor("recruiter", ["recruiter"])),
      hostWithCandidateRole: registerSurfaceIn(
        await renderPageFor("candidate", ["candidate", "recruiter"]),
      ),
      candidateWhoIsNoHost: registerSurfaceIn(
        await renderPageFor("candidate", ["candidate", "recruiter"]),
      ),
      hostQuestions: mocks.isHost.mock.calls,
    };

    const hostSurface = {
      registerControls: 0,
      rolePageLinks: 0,
      registrationLinks: 0,
      stickyBars: 0,
      hostNotes: 1,
      reviewInvitations: 0,
    };
    expect(seen).toEqual({
      hostWithoutCandidateRole: hostSurface,
      hostWithCandidateRole: hostSurface,
      candidateWhoIsNoHost: {
        registerControls: 2,
        rolePageLinks: 0,
        registrationLinks: 2,
        stickyBars: 1,
        hostNotes: 0,
        reviewInvitations: 1,
      },
      hostQuestions: [
        ["user-42", "competition-1"],
        ["user-42", "competition-1"],
        ["user-42", "competition-1"],
      ],
    });
  });
});
