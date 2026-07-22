// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildOwnerProfileResponse,
  buildPublicProfileResponse,
  parseProfilePatch,
  parseUsername,
  ProfileInputError,
  RESERVED_USERNAMES,
} from "@/server/user-profile/profile-core";
import { emptyProfileCollections } from "@/server/user-profile/profile-collections-core";

// ---------------------------------------------------------------------------
// buildOwnerProfileResponse — shared scalar fields + verification flags
// ---------------------------------------------------------------------------

describe("buildOwnerProfileResponse", () => {
  const baseRow = {
    id: "u1",
    username: "john_abc1",
    email: "john@example.com",
    role: "candidate",
    recruiterVerificationTier: "unverified" as const,
    displayName: "John Doe",
    summary: "A developer",
    location: "Jakarta",
    avatarUrl: null,
  };

  it("emits populated/empty for shared fields", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.displayName).toEqual({ status: "populated", value: "John Doe" });
    expect(resp.bio).toEqual({ status: "populated", value: "A developer" });
    expect(resp.location).toEqual({ status: "populated", value: "Jakarta" });
    expect(resp.avatarUrl).toEqual({ status: "empty", value: null });
  });

  it("emits candidateVerified and recruiterVerified flags correctly", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.candidateVerified).toBe(true);
    expect(resp.recruiterVerified).toBe(false);
  });

  it("defaults to empty collections and carries collections through when provided", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    expect(buildOwnerProfileResponse(row).collections).toEqual(emptyProfileCollections());

    const collections = {
      ...emptyProfileCollections(),
      skills: [{ id: "s1", name: "TypeScript" }],
    };
    expect(buildOwnerProfileResponse(row, collections).collections.skills).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildPublicProfileResponse — shared fields + verification trust flags
// ---------------------------------------------------------------------------

describe("buildPublicProfileResponse", () => {
  const baseRow = {
    username: "john_abc1",
    recruiterVerificationTier: "unverified" as const,
    displayName: "John Doe",
    summary: "A developer",
    location: "Jakarta",
    avatarUrl: null,
  };

  it("always emits shared fields regardless of verification state", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: null };
    const resp = buildPublicProfileResponse(row);

    expect(resp.username).toBe("john_abc1");
    expect(resp.displayName).toBe("John Doe");
    expect(resp.bio).toBe("A developer");
    expect(resp.location).toBe("Jakarta");
    expect(resp.avatarUrl).toBeNull();
  });

  it("exposes verification booleans as a public trust signal", () => {
    const verified = buildPublicProfileResponse({
      ...baseRow,
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });
    expect(verified.candidateVerified).toBe(true);
    expect(verified.recruiterVerified).toBe(false);

    const none = buildPublicProfileResponse({
      ...baseRow,
      candidateVerifiedAt: null,
      recruiterVerifiedAt: null,
    });
    expect(none.candidateVerified).toBe(false);
    expect(none.recruiterVerified).toBe(false);
  });

  it("exposes trustedRecruiter only when the recruiter tier is elevated", () => {
    const trusted = buildPublicProfileResponse({
      ...baseRow,
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    });
    expect(trusted.trustedRecruiter).toBe(true);

    const sandboxed = buildPublicProfileResponse({
      ...baseRow,
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "minimal",
    });
    expect(sandboxed.trustedRecruiter).toBe(false);
  });

  it("carries collections through", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: null };
    const collections = {
      ...emptyProfileCollections(),
      skills: [{ id: "s1", name: "Go" }],
    };
    expect(buildPublicProfileResponse(row, collections).collections.skills).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseUsername — username validation
// ---------------------------------------------------------------------------

describe("parseUsername", () => {
  it("accepts valid lowercase alphanumeric usernames", () => {
    expect(parseUsername("john123")).toBe("john123");
    expect(parseUsername("john_doe")).toBe("john_doe");
    expect(parseUsername("abc")).toBe("abc");
  });

  it("normalizes to lowercase", () => {
    expect(parseUsername("JohnDoe")).toBe("johndoe");
  });

  it("rejects usernames shorter than 3 characters", () => {
    expect(() => parseUsername("ab")).toThrowError(ProfileInputError);
  });

  it("rejects usernames longer than 30 characters", () => {
    expect(() => parseUsername("a".repeat(31))).toThrowError(ProfileInputError);
  });

  it("rejects usernames with invalid characters", () => {
    expect(() => parseUsername("john-doe")).toThrowError(ProfileInputError);
    expect(() => parseUsername("john.doe")).toThrowError(ProfileInputError);
    expect(() => parseUsername("john doe")).toThrowError(ProfileInputError);
  });

  it("rejects usernames starting or ending with underscore", () => {
    expect(() => parseUsername("_john")).toThrowError(ProfileInputError);
    expect(() => parseUsername("john_")).toThrowError(ProfileInputError);
  });

  it("rejects usernames with consecutive underscores", () => {
    expect(() => parseUsername("john__doe")).toThrowError(ProfileInputError);
  });

  it("rejects reserved usernames with code profile_username_reserved", () => {
    for (const reserved of RESERVED_USERNAMES) {
      try {
        parseUsername(reserved);
        expect.fail(`Expected parseUsername('${reserved}') to throw`);
      } catch (e) {
        expect(e).toBeInstanceOf(ProfileInputError);
        expect((e as ProfileInputError).code).toBe("profile_username_reserved");
      }
    }
  });

  it("rejects reserved usernames case-insensitively", () => {
    for (const value of ["ADMIN", "Admin", "admin"]) {
      try {
        parseUsername(value);
        expect.fail(`Expected parseUsername('${value}') to throw`);
      } catch (e) {
        expect((e as ProfileInputError).code).toBe("profile_username_reserved");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseProfilePatch — shared scalar fields only (no per-role scope gating)
// ---------------------------------------------------------------------------

describe("parseProfilePatch", () => {
  it("accepts shared fields", () => {
    const patch = parseProfilePatch({ displayName: "Jane", bio: "Hello" });
    expect(patch.displayName).toBe("Jane");
    expect(patch.bio).toBe("Hello");
  });

  it("rejects protected fields with profile_protected_fields", () => {
    try {
      parseProfilePatch({ email: "x@example.com" });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_protected_fields");
    }
  });

  it("rejects the retired scoped fields (and avatarUrl) as unknown fields", () => {
    // avatarUrl is now upload-managed, not a scalar PATCH field.
    for (const key of ["university", "roleTitle", "graduationYear", "websiteUrl", "avatarUrl"]) {
      try {
        parseProfilePatch({ [key]: "x" });
        expect.fail(`expected ${key} to be rejected`);
      } catch (e) {
        expect((e as ProfileInputError).code).toBe("profile_invalid_fields");
      }
    }
  });

  it("rejects unknown fields with profile_invalid_fields", () => {
    try {
      parseProfilePatch({ unknownField: "value" });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_invalid_fields");
    }
  });

  it("clears optional fields on null input", () => {
    const patch = parseProfilePatch({ bio: null, location: null });
    expect(patch.bio).toBeNull();
    expect(patch.location).toBeNull();
  });
});
