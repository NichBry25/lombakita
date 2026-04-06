import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";
import {
  AccessError,
  assertAuthenticatedSession,
  assertSessionRole,
} from "@/server/auth/access-core";

const buildSession = (overrides?: Partial<Session>): Session => {
  return {
    user: {
      id: "user_123",
      email: "student@example.com",
      role: "student",
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

  it("normalizes authenticated session", () => {
    const session = assertAuthenticatedSession(buildSession());

    expect(session.user.id).toBe("user_123");
    expect(session.user.role).toBe("student");
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
