// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { getRedirectError } from "next/dist/client/components/redirect";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AccessError } from "@/server/auth/access-core";
import { requireActiveSessionPage, requireRolePage } from "@/server/auth/page-guard";
import { createEnrolmentTestDatabase } from "@/server/auth/mfa/enrolment-test-db";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  start: vi.fn(),
  qr: vi.fn(),
  unverified: vi.fn(),
  competition: vi.fn(),
  registration: vi.fn(),
  team: vi.fn(),
  cancel: vi.fn(),
  charging: vi.fn(),
  search: vi.fn(),
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
vi.mock("@/components/auth/auth-page-frame", () => ({ AuthPageFrame: () => null }));
vi.mock("@/components/ui", () => ({
  PageHeader: () => null,
  ButtonLink: () => null,
  Feedback: () => null,
}));
vi.mock("./auth/mfa/challenge/mfa-challenge-form", () => ({ MfaChallengeForm: () => null }));
vi.mock("./auth/mfa/enroll/mfa-enroll-form", () => ({ MfaEnrollForm: () => null }));
vi.mock("./auth/verify-role/verify-role-form", () => ({ VerifyRoleForm: () => null }));
vi.mock("./competitions/[institutionSlug]/[slug]/registration/individual-section", () => ({
  IndividualRegistrationSection: () => null,
}));
vi.mock("./competitions/[institutionSlug]/[slug]/registration/team-section", () => ({
  CompetitionTeamSection: () => null,
}));
vi.mock("@/server/auth/mfa/factor-service", () => ({ startMfaEnrolment: mocks.start }));
vi.mock("@/server/auth/mfa/mfa-encryption", () => ({
  encryptMfaSecret: () => ({ ciphertext: "ciphertext", iv: "iv", authTag: "tag" }),
  decryptMfaSecret: vi.fn(),
}));
vi.mock("@/server/auth/mfa/otpauth-qr", () => ({ renderOtpauthQrDataUrl: mocks.qr }));
vi.mock("@/server/auth/role-verification", () => ({
  getUnverifiedRoles: mocks.unverified,
  isVerifiableRole: (role: string) => role === "candidate" || role === "recruiter",
  dashboardPathForRole: () => "/candidate-dashboard",
}));
vi.mock("@/server/competitions/competition-public-service", () => ({
  getPublicCompetitionDetail: mocks.competition,
}));
vi.mock("@/server/registrations/registration-service", () => ({
  getStudentRegistration: mocks.registration,
}));
vi.mock("@/server/teams/team-service", () => ({ getTeamForCompetitionAndCandidate: mocks.team }));
vi.mock("@/server/finance/cancel-affordance", () => ({
  resolveCancelAffordanceState: mocks.cancel,
}));
vi.mock("@/server/finance/charging-readiness", () => ({
  resolveChargingReadinessBySlug: mocks.charging,
}));

const session = (user: Partial<NonNullable<Session["user"]>> = {}): Session => ({
  user: {
    id: "user",
    role: "platform_ops",
    verifiedRoles: [],
    mfaStatus: "enrolment_required",
    ...user,
  },
  expires: "2099-01-01T00:00:00.000Z",
});
const searchProps = () => ({
  get searchParams() {
    mocks.search();
    return Promise.resolve({});
  },
});
const CASES = [
  {
    name: "challenge",
    file: "src/app/auth/mfa/challenge/page.tsx",
    callback: "/auth/mfa/challenge",
    user: { role: "platform_ops", mfaStatus: "challenge_required" },
    run: async () => (await import("./auth/mfa/challenge/page")).default(searchProps()),
  },
  {
    name: "enroll",
    file: "src/app/auth/mfa/enroll/page.tsx",
    callback: "/auth/mfa/enroll",
    user: { role: "platform_ops", mfaStatus: "enrolment_required" },
    run: async () => (await import("./auth/mfa/enroll/page")).default(searchProps()),
  },
  {
    name: "verify-role",
    file: "src/app/auth/verify-role/page.tsx",
    callback: "/",
    user: { role: "candidate", mfaStatus: "not_applicable" },
    run: async () =>
      (await import("./auth/verify-role/page")).default({
        get searchParams() {
          mocks.search();
          return Promise.resolve({ as: "candidate" });
        },
      }),
  },
  {
    name: "registration",
    file: "src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx",
    callback: "/competitions/institution/competition/registration",
    user: { role: "candidate", mfaStatus: "not_applicable" },
    run: async () =>
      (await import("./competitions/[institutionSlug]/[slug]/registration/page")).default({
        params: Promise.resolve({ institutionSlug: "institution", slug: "competition" }),
      }),
  },
] as const;
const READERS = [
  mocks.search,
  mocks.start,
  mocks.qr,
  mocks.unverified,
  mocks.competition,
  mocks.registration,
  mocks.team,
  mocks.cancel,
  mocks.charging,
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.start.mockResolvedValue({ secretBase32: "SECRET", otpauthUri: "otpauth://totp/test" });
  mocks.qr.mockResolvedValue("data:image/png;base64,test");
  mocks.unverified.mockResolvedValue(["candidate"]);
  mocks.competition.mockResolvedValue({
    id: "competition",
    mode: "both",
    feeAmount: 0,
    ctaState: "open",
  });
  mocks.registration.mockResolvedValue(null);
  mocks.team.mockResolvedValue(null);
  mocks.cancel.mockResolvedValue({
    individualCancellationClosed: false,
    teamCancellationClosed: false,
  });
});

describe.each(CASES)("active page $name", (entry) => {
  it("suspension ends exactly like requireRolePage before every reader", async () => {
    mocks.session.mockResolvedValue(
      session({ ...entry.user, suspendedAt: new Date(0).toISOString() }),
    );
    await expect(entry.run()).rejects.toMatchObject({
      digest: getRedirectError("/suspended", "replace").digest,
    });
    for (const reader of READERS) expect(reader).not.toHaveBeenCalled();
    await expect(
      requireRolePage(entry.user.role, { callbackPath: entry.callback }),
    ).rejects.toMatchObject({
      digest: getRedirectError("/suspended", "replace").digest,
    });
  });
  it("unauthenticated redirects with the same callback encoding before every reader", async () => {
    mocks.session.mockResolvedValue(null);
    const target = `/auth/login?callbackUrl=${encodeURIComponent(entry.callback)}`;
    await expect(entry.run()).rejects.toMatchObject({
      digest: getRedirectError(target, "replace").digest,
    });
    for (const reader of READERS) expect(reader).not.toHaveBeenCalled();
  });
  it("imports the real active-session guard and calls it first", () => {
    const source = ts.createSourceFile(
      entry.file,
      readFileSync(entry.file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const page = source.statements.find(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
    expect(page && ts.isFunctionDeclaration(page) && page.body).toBeTruthy();
    if (!page || !ts.isFunctionDeclaration(page) || !page.body)
      throw new Error("Cannot classify page");
    const first = page.body.statements[0];
    expect(first && ts.isVariableStatement(first)).toBe(true);
    if (!first || !ts.isVariableStatement(first))
      throw new Error("First statement is not the session guard");
    const initializer = first.declarationList.declarations[0]?.initializer;
    expect(
      initializer &&
        ts.isAwaitExpression(initializer) &&
        ts.isCallExpression(initializer.expression) &&
        initializer.expression.expression.getText(source),
    ).toBe("requireActiveSessionPage");
    expect(
      source.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "@/server/auth/page-guard" &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (binding) => binding.name.text === "requireActiveSessionPage" && !binding.propertyName,
          ),
      ),
    ).toBe(true);
  });
  it("still renders the permitted page", async () => {
    mocks.session.mockResolvedValue(session(entry.user));
    await expect(entry.run()).resolves.toBeTruthy();
    if (entry.name === "enroll") expect(mocks.start).toHaveBeenCalledOnce();
    if (entry.name === "verify-role") expect(mocks.unverified).toHaveBeenCalledOnce();
    if (entry.name === "registration") {
      expect(mocks.registration).toHaveBeenCalledOnce();
      expect(mocks.team).toHaveBeenCalledOnce();
    }
  });
});

describe("MFA page operational-role order", () => {
  for (const entry of CASES.slice(0, 2)) {
    it.each(["candidate", "recruiter", undefined, "unknown_role"])(
      `${entry.name} redirects %s before enrolment`,
      async (role) => {
        mocks.session.mockResolvedValue(session({ role: role as never }));
        await expect(entry.run()).rejects.toMatchObject({
          digest: getRedirectError("/", "replace").digest,
        });
        for (const reader of READERS) expect(reader).not.toHaveBeenCalled();
      },
    );
  }
  it("the shared guard admits a roleless session without imposing MFA", async () => {
    const roleless = session({ role: undefined, mfaStatus: "enrolment_required" });
    mocks.session.mockResolvedValue(roleless);
    expect(await requireActiveSessionPage({ callbackPath: "/" })).toEqual(roleless);
  });
});

describe("enrolment service race refusal", () => {
  it("redirects a factor verified after session resolution to the existing challenge path without writes", async () => {
    mocks.session.mockResolvedValue(session());
    const db = createEnrolmentTestDatabase({
      email: "operator@example.test",
      username: "operator",
      role: "platform_ops",
      status: "active",
      suspendedAt: null,
    });
    const factor = { id: "factor", userId: "user", verifiedAt: new Date(0) };
    db.factorRows.push(factor);
    const actual = await vi.importActual<typeof import("@/server/auth/mfa/factor-service")>(
      "@/server/auth/mfa/factor-service",
    );
    mocks.start.mockImplementation((id: string) => actual.startMfaEnrolment(id, db.database));
    await expect(CASES[1].run()).rejects.toMatchObject({
      digest: getRedirectError("/auth/mfa/challenge?callbackUrl=%2Fadmin", "replace").digest,
    });
    expect(db.factorRows).toEqual([factor]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.qr).not.toHaveBeenCalled();
  });
  it.each([
    { status: "active", suspendedAt: new Date(0), target: "/suspended" },
    { status: "deactivated", suspendedAt: null, target: "/" },
  ])(
    "redirects race refusal to $target with no factor row",
    async ({ status, suspendedAt, target }) => {
      mocks.session.mockResolvedValue(session());
      const db = createEnrolmentTestDatabase({
        email: "operator@example.test",
        username: "operator",
        role: "platform_ops",
        status,
        suspendedAt,
      });
      const actual = await vi.importActual<typeof import("@/server/auth/mfa/factor-service")>(
        "@/server/auth/mfa/factor-service",
      );
      mocks.start.mockImplementation((id: string) => actual.startMfaEnrolment(id, db.database));
      await expect(CASES[1].run()).rejects.toMatchObject({
        digest: getRedirectError(target, "replace").digest,
      });
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(db.factorRows).toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(mocks.qr).not.toHaveBeenCalled();
    },
  );
  it.each([
    new Error("unexpected service failure"),
    new AccessError("unauthenticated", 401, "Authentication required"),
    new AccessError("session_user_mismatch", 409, "Session changed"),
    new AccessError("mfa_enrolment_required", 403, "MFA required"),
    new AccessError("mfa_challenge_required", 403, "MFA required"),
  ])("rethrows other errors unchanged: %s", async (error) => {
    mocks.session.mockResolvedValue(session());
    mocks.start.mockRejectedValue(error);
    await expect(CASES[1].run()).rejects.toBe(error);
    expect(mocks.qr).not.toHaveBeenCalled();
  });
});
