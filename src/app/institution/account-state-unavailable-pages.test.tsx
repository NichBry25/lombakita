// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const state = vi.hoisted(() => ({
  role: vi.fn(),
  admin: vi.fn(),
  competitionId: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  feeStatement: vi.fn(),
  review: vi.fn(),
  participants: vi.fn(),
  payments: vi.fn(),
  readiness: vi.fn(),
  select: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: state.redirect, notFound: state.notFound }));
vi.mock("@/server/auth/page-guard", () => ({ requireRolePage: state.role }));
vi.mock("@/server/db/client", () => ({ getDb: () => ({ select: state.select }) }));
vi.mock("@/server/institution-members/member-service", () => ({
  requireAdminInstitutionBySlug: state.admin,
  isInstitutionAdminBySlug: async () => true,
  isInstitutionOwnerBySlug: async () => true,
}));
vi.mock("@/server/competitions/competition-service", () => ({
  getCompetitionIdByInstitutionAndSlug: state.competitionId,
  getCompetitionIdentityByInstitutionAndSlug: vi.fn(),
  loadCompetitionPricing: vi.fn(),
}));
vi.mock("@/server/competitions/competition-publish-readiness", () => ({
  resolveCompetitionPublishReadiness: state.readiness,
}));
vi.mock("@/server/finance/fee-statement", () => ({
  loadInstitutionFeeStatement: state.feeStatement,
}));
vi.mock("@/server/participants/review-service", () => ({ getRegistrationReview: state.review }));
vi.mock("@/server/participants/result-service", () => ({ getResultForInstitution: vi.fn() }));
vi.mock("@/server/participants/submission-file-service", () => ({
  getSubmissionForInstitution: vi.fn(),
}));
vi.mock("@/server/participants/participant-service", () => ({
  listCompetitionParticipants: state.participants,
}));
vi.mock("@/server/finance/organiser-payment-review", () => ({
  loadOrganiserPaymentQueue: state.payments,
}));
vi.mock("@/server/registration-documents/registration-document-service", () => ({
  listDocumentRequestsForCompetition: vi.fn(),
  listRegistrationIdsEligibleForDocumentRequest: vi.fn(),
}));

const props = () => ({
  params: Promise.resolve({
    institutionSlug: "institution",
    competitionSlug: "competition",
    registrationId: "registration",
  }),
  searchParams: Promise.resolve({}),
});

const pages = [
  {
    name: "fees",
    failure: state.admin,
    run: async () => (await import("./[institutionSlug]/fees/page")).default(props()),
    destination: "redirect",
  },
  {
    name: "registration review",
    failure: state.admin,
    run: async () =>
      (
        await import("./[institutionSlug]/competitions/[competitionSlug]/participants/[registrationId]/page")
      ).default(props()),
    destination: "redirect",
  },
  {
    name: "participants",
    failure: state.admin,
    run: async () =>
      (
        await import("./[institutionSlug]/competitions/[competitionSlug]/participants/page")
      ).default(props()),
    destination: "redirect",
  },
  {
    name: "payments",
    failure: state.admin,
    run: async () =>
      (await import("./[institutionSlug]/competitions/[competitionSlug]/payments/page")).default(
        props(),
      ),
    destination: "redirect",
  },
  {
    name: "audit log",
    failure: state.admin,
    run: async () => (await import("./[institutionSlug]/audit-log/page")).default(props()),
    destination: "redirect",
  },
  {
    name: "competition edit",
    failure: state.competitionId,
    run: async () =>
      (await import("./[institutionSlug]/competitions/[competitionSlug]/edit/page")).default(
        props(),
      ),
    destination: "notFound",
  },
  {
    name: "competition detail",
    failure: state.competitionId,
    run: async () =>
      (await import("./[institutionSlug]/competitions/[competitionSlug]/page")).default(props()),
    destination: "notFound",
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  state.role.mockResolvedValue({ user: { id: "recruiter", role: "recruiter" } });
  state.admin.mockResolvedValue({ institutionId: "institution" });
  state.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
  state.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});

describe.each(pages)("institution page $name", (page) => {
  it("rethrows account_state_unavailable from the catch before any navigation", async () => {
    const error = new AccessError(
      "account_state_unavailable" as never,
      503 as never,
      "Account status is temporarily unavailable",
    );
    page.failure.mockRejectedValue(error);
    await expect(page.run()).rejects.toBe(error);
    expect(state.redirect).not.toHaveBeenCalled();
    expect(state.notFound).not.toHaveBeenCalled();
    for (const reader of [
      state.feeStatement,
      state.review,
      state.participants,
      state.payments,
      state.readiness,
      state.select,
    ]) {
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it("keeps the existing navigation for forbidden access", async () => {
    page.failure.mockRejectedValue(new AccessError("forbidden", 403, "Insufficient permissions"));
    await expect(page.run()).rejects.toThrow(
      page.destination === "redirect" ? "NEXT_REDIRECT" : "NEXT_NOT_FOUND",
    );
  });
});
