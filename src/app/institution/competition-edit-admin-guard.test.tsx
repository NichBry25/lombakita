// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { getRedirectError } from "next/dist/client/components/redirect";

// The session and the admin check's answer are the hand-built inputs. The real requireRolePage
// resolves the session, so the user id the admin check receives comes through the production path.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  isAdmin: vi.fn(),
  isOwner: vi.fn(),
  lookup: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ getCurrentSession: mocks.session }));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw getRedirectError(path, "replace");
  },
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/institution-members/member-service", () => ({
  isInstitutionAdminBySlug: mocks.isAdmin,
  isInstitutionOwnerBySlug: mocks.isOwner,
}));
vi.mock("@/server/competitions/competition-service", () => ({
  getCompetitionIdByInstitutionAndSlug: mocks.lookup,
}));
vi.mock("@/server/competitions/competition-publish-readiness", () => ({
  resolveCompetitionPublishReadiness: mocks.readiness,
}));
vi.mock("@/components/institution/institution-competition-edit-shell", () => ({
  InstitutionCompetitionEditShell: () => null,
}));
vi.mock("@/components/institution/competition-prizes-editor", () => ({
  CompetitionPrizesEditor: () => null,
}));
vi.mock("@/components/institution/competition-rounds-editor", () => ({
  CompetitionRoundsEditor: () => null,
}));
vi.mock("@/components/institution/competition-tags-editor", () => ({
  CompetitionTagsEditor: () => null,
}));
vi.mock("@/components/institution/competition-eligibility-editor", () => ({
  CompetitionEligibilityEditor: () => null,
}));
vi.mock("@/components/institution/competition-fee-section", () => ({
  CompetitionFeeSection: () => null,
}));
vi.mock("@/components/institution/competition-contact-editor", () => ({
  CompetitionContactEditor: () => null,
}));

const recruiterSession = (): Session => ({
  user: {
    id: "recruiter-user",
    role: "recruiter",
    verifiedRoles: ["recruiter"],
    mfaStatus: "not_applicable",
  },
  expires: "2099-01-01T00:00:00.000Z",
});

const renderEditPage = async () => {
  const page = await import("./[institutionSlug]/competitions/[competitionSlug]/edit/page");
  return page.default({
    params: Promise.resolve({ institutionSlug: "institution", competitionSlug: "competition" }),
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(recruiterSession());
  mocks.isOwner.mockResolvedValue(true);
  mocks.lookup.mockResolvedValue("competition-id");
  mocks.readiness.mockResolvedValue({ ready: false });
});

describe("competition edit page institution-admin guard", () => {
  it("redirects a recruiter who is not an institution admin to / before the competition lookup", async () => {
    mocks.isAdmin.mockResolvedValue(false);

    await expect(renderEditPage()).rejects.toMatchObject({
      digest: getRedirectError("/", "replace").digest,
    });
    expect(mocks.isAdmin).toHaveBeenCalledWith("recruiter-user", "institution");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
  });

  it("lets an institution admin reach the competition lookup", async () => {
    mocks.isAdmin.mockResolvedValue(true);

    await expect(renderEditPage()).resolves.toBeTruthy();
    expect(mocks.lookup).toHaveBeenCalledWith("institution", "competition");
  });

  it("runs the role gate before the admin check", async () => {
    mocks.session.mockResolvedValue(null);
    const loginPath = `/auth/login?callbackUrl=${encodeURIComponent(
      "/institution/institution/competitions/competition/edit",
    )}`;

    await expect(renderEditPage()).rejects.toMatchObject({
      digest: getRedirectError(loginPath, "replace").digest,
    });
    expect(mocks.isAdmin).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("tells the fee section that a staff member is not the owner", async () => {
    mocks.isAdmin.mockResolvedValue(true);
    mocks.isOwner.mockResolvedValue(false);

    const page = await renderEditPage();

    expect(page.props.children[4].props).toMatchObject({ viewerIsOwner: false });
    expect(page.props.stepChildren[4].props.children[1].props).toMatchObject({
      viewerIsOwner: false,
    });
  });

  it("tells the fee section that the owner is the owner, checked for the editor's institution", async () => {
    mocks.isAdmin.mockResolvedValue(true);
    mocks.isOwner.mockResolvedValue(true);

    const page = await renderEditPage();

    expect(page.props.children[4].props).toMatchObject({ viewerIsOwner: true });
    expect(page.props.stepChildren[4].props.children[1].props).toMatchObject({
      viewerIsOwner: true,
    });
    expect(mocks.isOwner).toHaveBeenCalledWith("recruiter-user", "institution");
  });

  it("hands the contact part the competition and the signed-in viewer", async () => {
    mocks.isAdmin.mockResolvedValue(true);

    const page = await renderEditPage();

    expect(page.props.contactEditor.props).toEqual({
      competitionId: "competition-id",
      expectedUserId: "recruiter-user",
    });
  });
});
