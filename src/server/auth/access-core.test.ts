import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";
import {
  AccessError,
  assertAuthenticatedSession,
  assertSessionRole,
  normalizeSessionRole,
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
