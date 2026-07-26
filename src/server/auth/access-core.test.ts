import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";
import {
  AccessError,
  assertAuthenticatedSession,
  assertSessionMatchesExpectedUser,
  assertSessionRole,
  normalizeSessionRole,
  type AuthenticatedSession,
} from "@/server/auth/access-core";

const buildSession = (overrides?: Partial<Session>): Session => {
  return {
    user: {
      id: "user_123",
      email: "candidate@example.com",
      role: "candidate",
      name: null,
      image: null,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  } as Session;
};

describe("access-core", () => {
  it("throws unauthenticated when session is missing", () => {
    expect(() => assertAuthenticatedSession(null)).toThrow(AccessError);
  });

  it("normalizes authenticated session for a candidate", () => {
    const session = assertAuthenticatedSession(buildSession());

    expect(session.user.id).toBe("user_123");
    expect(session.user.role).toBe("candidate");
  });

  it("throws forbidden for disallowed roles", () => {
    const session = assertAuthenticatedSession(buildSession());

    expect(() => assertSessionRole(session, ["platform_ops"])).toThrowError(
      /Insufficient role permissions/i,
    );
  });

  it("allows explicitly permitted roles", () => {
    const session = assertAuthenticatedSession(
      buildSession({ user: { id: "ops_1", role: "platform_ops" } as Session["user"] }),
    );

    const guarded = assertSessionRole(session, ["platform_ops", "finance_ops"]);

    expect(guarded.user.role).toBe("platform_ops");
  });

  // DEC-0060 capability model — a dual-verified self-service account signed in under one role
  // still satisfies a gate for its other verified role.
  it("allows a candidate gate for a recruiter-active account that also has candidate verified", () => {
    const session = assertAuthenticatedSession(
      buildSession({
        user: {
          id: "dual_1",
          role: "recruiter",
          verifiedRoles: ["candidate", "recruiter"],
        } as Session["user"],
      }),
    );

    expect(() => assertSessionRole(session, ["candidate"])).not.toThrow();
    expect(() => assertSessionRole(session, ["recruiter"])).not.toThrow();
  });

  it("forbids a recruiter gate for a candidate-only account", () => {
    const session = assertAuthenticatedSession(
      buildSession({
        user: {
          id: "cand_only",
          role: "candidate",
          verifiedRoles: ["candidate"],
        } as Session["user"],
      }),
    );

    expect(() => assertSessionRole(session, ["recruiter"])).toThrowError(
      /Insufficient role permissions/i,
    );
  });

  // No privilege widening: an operational account whose candidate_verified_at is a migration
  // CHECK-satisfier (surfaced as verifiedRoles: ["candidate"]) must NOT gain candidate access,
  // because its active role is not self-service.
  it("forbids a candidate gate for a platform_ops account even when verifiedRoles contains candidate", () => {
    const session = assertAuthenticatedSession(
      buildSession({
        user: {
          id: "ops_backfill",
          role: "platform_ops",
          verifiedRoles: ["candidate"],
        } as Session["user"],
      }),
    );

    expect(() => assertSessionRole(session, ["candidate"])).toThrowError(
      /Insufficient role permissions/i,
    );
    // its own operational gate still passes
    expect(() => assertSessionRole(session, ["platform_ops"])).not.toThrow();
  });

  // Step 6.2 — suspension gate.
  it("throws account_suspended (403) when session.user.suspendedAt is set, before any role check", () => {
    const suspended = buildSession({
      user: {
        id: "user_123",
        role: "candidate",
        suspendedAt: "2026-06-02T00:00:00.000Z",
      } as Session["user"],
    });

    try {
      assertAuthenticatedSession(suspended);
      throw new Error("expected AccessError");
    } catch (e) {
      expect(e).toBeInstanceOf(AccessError);
      expect((e as AccessError).code).toBe("account_suspended");
      expect((e as AccessError).status).toBe(403);
    }
  });

  it("does not block when suspendedAt is absent", () => {
    const session = assertAuthenticatedSession(buildSession());
    expect(session.user.id).toBe("user_123");
  });
});

describe("normalizeSessionRole — Rollback Step 1.3 fail-clean behaviour", () => {
  it.each(["candidate", "recruiter", "reviewer_or_judge", "platform_ops", "finance_ops"] as const)(
    "accepts %s as a valid user-level role",
    (role) => {
      expect(normalizeSessionRole(role)).toBe(role);
    },
  );

  it.each(["student", "institution_admin", "institution_staff"])(
    "rejects legacy pre-rollback token %s with AccessError unauthenticated",
    (legacyRole) => {
      expect(() => normalizeSessionRole(legacyRole)).toThrowError(AccessError);
    },
  );

  it("rejects unknown tokens", () => {
    expect(() => normalizeSessionRole("not_a_real_role")).toThrowError(AccessError);
  });

  it("rejects null / undefined / empty strings", () => {
    expect(() => normalizeSessionRole(null)).toThrowError(AccessError);
    expect(() => normalizeSessionRole(undefined)).toThrowError(AccessError);
    expect(() => normalizeSessionRole("")).toThrowError(AccessError);
  });

  it("rejects a session whose role field carries the legacy 'student' token", () => {
    const session = {
      user: { id: "user_legacy", role: "student", email: "x@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as Session;

    expect(() => assertAuthenticatedSession(session)).toThrowError(AccessError);
  });

  it("rejects a session whose role field carries the legacy 'institution_admin' token", () => {
    const session = {
      user: { id: "user_legacy_admin", role: "institution_admin", email: "x@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as Session;

    expect(() => assertAuthenticatedSession(session)).toThrowError(AccessError);
  });
});

describe("assertSessionMatchesExpectedUser — cross-session form-submission guard", () => {
  const buildAuthSession = (userId: string): AuthenticatedSession =>
    assertAuthenticatedSession(
      buildSession({ user: { id: userId, role: "candidate" } as Session["user"] }),
    );

  const makeRequest = (header?: string): Request => {
    const headers = new Headers();
    if (header !== undefined) {
      headers.set("X-Expected-User-Id", header);
    }
    return new Request("http://localhost/api/v1/candidate/me/profile", {
      method: "PATCH",
      headers,
    });
  };

  it("passes when header matches session.user.id", () => {
    const session = buildAuthSession("user_match");
    const request = makeRequest("user_match");
    expect(() => assertSessionMatchesExpectedUser(request, session)).not.toThrow();
  });

  it("throws session_user_mismatch (409) when header differs from session", () => {
    const session = buildAuthSession("user_session");
    const request = makeRequest("user_different");
    try {
      assertSessionMatchesExpectedUser(request, session);
      expect.fail("expected AccessError");
    } catch (err) {
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("session_user_mismatch");
      expect((err as AccessError).status).toBe(409);
    }
  });

  it("passes when header is absent (backward compatibility with older clients)", () => {
    const session = buildAuthSession("user_no_header");
    const request = makeRequest(undefined);
    expect(() => assertSessionMatchesExpectedUser(request, session)).not.toThrow();
  });

  it("passes when header is empty string (treated as absent)", () => {
    const session = buildAuthSession("user_empty_header");
    const request = makeRequest("");
    expect(() => assertSessionMatchesExpectedUser(request, session)).not.toThrow();
  });
});
