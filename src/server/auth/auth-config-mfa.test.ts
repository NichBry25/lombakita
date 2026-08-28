// @vitest-environment node
//
// Step 7.1-MFA wiring inside auth.config.ts: the jwt callback's elevation-grant consume (the one
// place a client-controlled `update()` payload could become a bypass if trusted directly) and the
// session callback's mfaStatus projection. Mirrors auth-config-live-role.test.ts's mock shape,
// extended with the mfa_factors EXISTS projection and the elevation-grant consume.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryRow = {
  role: string | null;
  suspendedAt: Date | null;
  mfaInvalidatedAt: Date | null;
  hasVerifiedMfaFactor: boolean;
};

type QueryOutcome = { kind: "row"; row: QueryRow } | { kind: "empty" } | { kind: "error" };

let queryOutcome: QueryOutcome = {
  kind: "row",
  row: {
    role: "platform_ops",
    suspendedAt: null,
    mfaInvalidatedAt: null,
    hasVerifiedMfaFactor: false,
  },
};

const limitMock = vi.fn(async () => {
  if (queryOutcome.kind === "error") {
    throw new Error("connection terminated unexpectedly");
  }
  if (queryOutcome.kind === "empty") {
    return [];
  }
  return [queryOutcome.row];
});

const selectMock = vi.fn(() => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ limit: limitMock }),
  }),
}));

const getDbMock = vi.fn(() => ({ select: selectMock }));

const consumeMfaElevationGrantMock = vi.fn();

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({ adapter: "mock" })) }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn((c: unknown) => c) }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "http://localhost:3000" } }));
vi.mock("@/config/env.server", () => ({
  assertRuntimeEnv: vi.fn(),
  serverEnv: {
    resendApiKey: "k",
    authEmailFrom: "noreply@example.com",
    databaseUrl: "postgresql://local",
    authSecret: "secret",
    authUrl: "http://localhost:3000",
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/auth/credentials-auth", () => ({ authenticateWithEmailPassword: vi.fn() }));
vi.mock("@/server/auth/mfa/mfa-elevation", () => ({
  consumeMfaElevationGrant: consumeMfaElevationGrantMock,
}));
vi.mock("@/server/db/client", () => ({ getDb: getDbMock }));
vi.mock("@/server/db/schema", () => ({
  users: {
    id: "id",
    role: "role",
    suspendedAt: "suspended_at",
    candidateVerifiedAt: "c",
    recruiterVerifiedAt: "r",
    mfaInvalidatedAt: "mfa_invalidated_at",
  },
  mfaFactors: { userId: "user_id", verifiedAt: "verified_at" },
  accounts: {},
  sessions: {},
  verificationTokens: {},
  candidateOccupationEnum: {
    enumValues: ["school_student", "college_student", "new_graduate", "professional", "other"],
  },
  candidateProfiles: {
    userId: "user_id",
    fullName: "full_name",
    phoneNumber: "phone_number",
    occupation: "occupation",
    dateOfBirth: "date_of_birth",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type JwtCb = (args: {
  token: Record<string, unknown>;
  user?: Record<string, unknown>;
  trigger?: string;
  session?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

type SessionCb = (args: {
  session: { user?: Record<string, unknown> };
  token: Record<string, unknown>;
}) => Promise<{ user?: Record<string, unknown> }>;

const callJwt = async (args: Parameters<JwtCb>[0]) => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const cb = authOptions.callbacks?.jwt as unknown as JwtCb;
  return cb(args);
};

const callSession = async (token: Record<string, unknown>) => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const cb = authOptions.callbacks?.session as unknown as SessionCb;
  return cb({ session: { user: { email: "ops@example.com" } }, token });
};

beforeEach(() => {
  queryOutcome = {
    kind: "row",
    row: {
      role: "platform_ops",
      suspendedAt: null,
      mfaInvalidatedAt: null,
      hasVerifiedMfaFactor: true,
    },
  };
  consumeMfaElevationGrantMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("jwt callback — MFA elevation grant", () => {
  it("stamps mfaVerifiedAt when the consumed grant belongs to this token's user", async () => {
    consumeMfaElevationGrantMock.mockResolvedValue("user_123");

    const result = await callJwt({
      token: { sub: "user_123" },
      trigger: "update",
      session: { mfaElevationGrant: "grant_abc" },
    });

    expect(consumeMfaElevationGrantMock).toHaveBeenCalledWith("grant_abc");
    expect(typeof result.mfaVerifiedAt).toBe("number");
  });

  // GUARD-REMOVAL PROOF target: the callback's ownership comparison
  // (`grantedUserId === token.sub`). Deleting that comparison makes this test fail — a grant
  // consumed for a DIFFERENT user would otherwise elevate this token.
  it("does not stamp mfaVerifiedAt when the consumed grant belongs to a different user", async () => {
    consumeMfaElevationGrantMock.mockResolvedValue("someone_else");

    const result = await callJwt({
      token: { sub: "user_123" },
      trigger: "update",
      session: { mfaElevationGrant: "grant_abc" },
    });

    expect(result.mfaVerifiedAt).toBeUndefined();
  });

  it("does not stamp mfaVerifiedAt when the grant is missing, expired, or already consumed", async () => {
    consumeMfaElevationGrantMock.mockResolvedValue(null);

    const result = await callJwt({
      token: { sub: "user_123" },
      trigger: "update",
      session: { mfaElevationGrant: "grant_abc" },
    });

    expect(result.mfaVerifiedAt).toBeUndefined();
  });

  it("does not stamp mfaVerifiedAt and does not throw when the consume itself throws", async () => {
    consumeMfaElevationGrantMock.mockRejectedValue(new Error("redis unavailable"));

    const result = await callJwt({
      token: { sub: "user_123" },
      trigger: "update",
      session: { mfaElevationGrant: "grant_abc" },
    });

    expect(result.mfaVerifiedAt).toBeUndefined();
  });

  // GUARD-REMOVAL PROOF target: the entire point of the elevation-grant indirection. The callback
  // must ignore anything the client asserts about itself and consult ONLY the server-side grant
  // store. A client typing `update({ mfaVerified: true })` — or any shape with no
  // `mfaElevationGrant` string — must never elevate, and `consumeMfaElevationGrant` must never
  // even be called for it.
  it("ignores a forged client payload asserting MFA verification with no real grant id", async () => {
    const result = await callJwt({
      token: { sub: "user_123" },
      trigger: "update",
      session: { mfaVerified: true } as unknown as Record<string, unknown>,
    });

    expect(consumeMfaElevationGrantMock).not.toHaveBeenCalled();
    expect(result.mfaVerifiedAt).toBeUndefined();
  });

  it("does not consume a grant outside an update trigger", async () => {
    await callJwt({
      token: { sub: "user_123" },
      session: { mfaElevationGrant: "grant_abc" },
    });

    expect(consumeMfaElevationGrantMock).not.toHaveBeenCalled();
  });

  it("clears a carried mfaVerifiedAt on a fresh sign-in", async () => {
    const result = await callJwt({
      token: { sub: "user_123", mfaVerifiedAt: 1_700_000_000 },
      user: { id: "user_123", role: "platform_ops" },
    });

    expect(result.mfaVerifiedAt).toBeUndefined();
  });
});

describe("session callback — mfaStatus", () => {
  const tokenFor = (role: string, mfaVerifiedAt?: number) => ({
    sub: "user_123",
    role,
    verifiedRoles: [],
    ...(mfaVerifiedAt !== undefined ? { mfaVerifiedAt } : {}),
  });

  it("is not_applicable for a self-service role even with no verified factor", async () => {
    queryOutcome = {
      kind: "row",
      row: {
        role: "candidate",
        suspendedAt: null,
        mfaInvalidatedAt: null,
        hasVerifiedMfaFactor: false,
      },
    };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.mfaStatus).toBe("not_applicable");
  });

  it("is enrolment_required for an operational role with no verified factor", async () => {
    queryOutcome = {
      kind: "row",
      row: {
        role: "platform_ops",
        suspendedAt: null,
        mfaInvalidatedAt: null,
        hasVerifiedMfaFactor: false,
      },
    };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.mfaStatus).toBe("enrolment_required");
  });

  it("is challenge_required for a verified factor with no mfaVerifiedAt claim on the token", async () => {
    queryOutcome = {
      kind: "row",
      row: {
        role: "platform_ops",
        suspendedAt: null,
        mfaInvalidatedAt: null,
        hasVerifiedMfaFactor: true,
      },
    };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.mfaStatus).toBe("challenge_required");
  });

  it("is satisfied when the token's claim is at or after the live invalidation stamp", async () => {
    const invalidatedAt = new Date("2026-08-01T00:00:00.000Z");
    queryOutcome = {
      kind: "row",
      row: {
        role: "platform_ops",
        suspendedAt: null,
        mfaInvalidatedAt: invalidatedAt,
        hasVerifiedMfaFactor: true,
      },
    };
    const claimSeconds = Math.floor(invalidatedAt.getTime() / 1000) + 60;

    const result = await callSession(tokenFor("platform_ops", claimSeconds));

    expect(result.user?.mfaStatus).toBe("satisfied");
  });

  // GUARD-REMOVAL PROOF target: the stale-claim comparison in mfa-status.ts's resolveMfaStatus.
  // Deleting that comparison (accepting any non-null claim as satisfied) makes this test fail — a
  // JWT minted BEFORE a recovery-code reset would otherwise keep reading as satisfied forever.
  it("is challenge_required when the token's claim predates the live invalidation stamp", async () => {
    const invalidatedAt = new Date("2026-08-01T00:00:00.000Z");
    queryOutcome = {
      kind: "row",
      row: {
        role: "platform_ops",
        suspendedAt: null,
        mfaInvalidatedAt: invalidatedAt,
        hasVerifiedMfaFactor: true,
      },
    };
    const staleClaimSeconds = Math.floor(invalidatedAt.getTime() / 1000) - 60;

    const result = await callSession(tokenFor("platform_ops", staleClaimSeconds));

    expect(result.user?.mfaStatus).toBe("challenge_required");
  });

  it("is not_applicable when the live database read is unreachable (role falls closed for operational)", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("platform_ops"));

    // resolveEffectiveRole fails closed to undefined for an operational role on a DB error, so
    // mfaStatus reads not_applicable — normalizeSessionRole is what rejects the roleless session
    // downstream; this fold does not need to reproduce that rejection.
    expect(result.user?.role).toBeUndefined();
    expect(result.user?.mfaStatus).toBe("not_applicable");
  });

  it("projects mfaInvalidatedAt and the verified-factor existence in the same select", async () => {
    await callSession(tokenFor("platform_ops"));

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mfaInvalidatedAt: expect.anything(),
        hasVerifiedMfaFactor: expect.anything(),
      }),
    );
    expect(limitMock).toHaveBeenCalledTimes(1);
  });
});
