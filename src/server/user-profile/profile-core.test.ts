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

// ---------------------------------------------------------------------------
// buildOwnerProfileResponse — scope-indicator logic
// ---------------------------------------------------------------------------

describe("buildOwnerProfileResponse", () => {
  const baseRow = {
    id: "u1",
    username: "john_abc1",
    email: "john@example.com",
    role: "candidate",
    displayName: "John Doe",
    summary: "A developer",
    location: "Jakarta",
    avatarUrl: null,
    university: "UI",
    major: "Computer Science",
    graduationYear: 2024,
    roleTitle: "CTO",
    organizationName: "Acme",
    websiteUrl: "https://example.com",
  };

  it("emits populated for filled shared fields when candidate verified", () => {
    const row = {
      ...baseRow,
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.displayName).toEqual({ status: "populated", value: "John Doe" });
    expect(resp.bio).toEqual({ status: "populated", value: "A developer" });
    expect(resp.location).toEqual({ status: "populated", value: "Jakarta" });
    expect(resp.avatarUrl).toEqual({ status: "empty", value: null });
  });

  it("emits populated for candidate fields when candidateVerifiedAt is set", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.university).toEqual({ status: "populated", value: "UI" });
    expect(resp.major).toEqual({ status: "populated", value: "Computer Science" });
    expect(resp.graduationYear).toEqual({ status: "populated", value: 2024 });
  });

  it("emits scope-gated for candidate fields when candidateVerifiedAt is null", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: new Date() };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.university).toEqual({ status: "scope-gated" });
    expect(resp.major).toEqual({ status: "scope-gated" });
    expect(resp.graduationYear).toEqual({ status: "scope-gated" });
  });

  it("emits populated for recruiter fields when recruiterVerifiedAt is set", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: new Date() };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.roleTitle).toEqual({ status: "populated", value: "CTO" });
    expect(resp.organizationName).toEqual({ status: "populated", value: "Acme" });
    expect(resp.websiteUrl).toEqual({ status: "populated", value: "https://example.com" });
  });

  it("emits scope-gated for recruiter fields when recruiterVerifiedAt is null", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.roleTitle).toEqual({ status: "scope-gated" });
    expect(resp.organizationName).toEqual({ status: "scope-gated" });
    expect(resp.websiteUrl).toEqual({ status: "scope-gated" });
  });

  it("emits candidateVerified and recruiterVerified flags correctly", () => {
    const cv = new Date();
    const row = { ...baseRow, candidateVerifiedAt: cv, recruiterVerifiedAt: null };
    const resp = buildOwnerProfileResponse(row);

    expect(resp.candidateVerified).toBe(true);
    expect(resp.recruiterVerified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPublicProfileResponse — scope-gated fields omitted entirely
// ---------------------------------------------------------------------------

describe("buildPublicProfileResponse", () => {
  const baseRow = {
    username: "john_abc1",
    displayName: "John Doe",
    summary: "A developer",
    location: "Jakarta",
    avatarUrl: null,
    university: "UI",
    major: "CS",
    graduationYear: 2024,
    roleTitle: "CTO",
    organizationName: "Acme",
    websiteUrl: "https://example.com",
  };

  it("includes candidate fields only when candidateVerifiedAt is set", () => {
    const row = { ...baseRow, candidateVerifiedAt: new Date(), recruiterVerifiedAt: null };
    const resp = buildPublicProfileResponse(row);

    expect("university" in resp).toBe(true);
    expect(resp.university).toBe("UI");
    expect("roleTitle" in resp).toBe(false);
  });

  it("includes recruiter fields only when recruiterVerifiedAt is set", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: new Date() };
    const resp = buildPublicProfileResponse(row);

    expect("roleTitle" in resp).toBe(true);
    expect(resp.roleTitle).toBe("CTO");
    expect("university" in resp).toBe(false);
  });

  it("omits all scoped fields when both verification timestamps are null", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: null };
    const resp = buildPublicProfileResponse(row);

    expect("university" in resp).toBe(false);
    expect("major" in resp).toBe(false);
    expect("graduationYear" in resp).toBe(false);
    expect("roleTitle" in resp).toBe(false);
    expect("organizationName" in resp).toBe(false);
    expect("websiteUrl" in resp).toBe(false);
  });

  it("always emits shared fields regardless of verification state", () => {
    const row = { ...baseRow, candidateVerifiedAt: null, recruiterVerifiedAt: null };
    const resp = buildPublicProfileResponse(row);

    expect(resp.username).toBe("john_abc1");
    expect(resp.displayName).toBe("John Doe");
    expect(resp.bio).toBe("A developer");
    expect(resp.location).toBe("Jakarta");
    expect(resp.avatarUrl).toBeNull();
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
// parseProfilePatch — scope enforcement
// ---------------------------------------------------------------------------

describe("parseProfilePatch", () => {
  it("accepts shared fields for any verified account", () => {
    const patch = parseProfilePatch({ displayName: "Jane", bio: "Hello" }, true, false);
    expect(patch.displayName).toBe("Jane");
    expect(patch.bio).toBe("Hello");
  });

  it("accepts candidate fields when candidateVerified is true", () => {
    const patch = parseProfilePatch({ university: "UI" }, true, false);
    expect(patch.university).toBe("UI");
  });

  it("rejects candidate fields when candidateVerified is false", () => {
    expect(() => parseProfilePatch({ university: "UI" }, false, true)).toThrowError(
      ProfileInputError,
    );
    try {
      parseProfilePatch({ university: "UI" }, false, true);
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_scope_violation");
      expect((e as ProfileInputError).details?.requiredRole).toBe("candidate");
      expect((e as ProfileInputError).details?.fields).toContain("university");
    }
  });

  it("accepts recruiter fields when recruiterVerified is true", () => {
    const patch = parseProfilePatch({ roleTitle: "CEO" }, false, true);
    expect(patch.roleTitle).toBe("CEO");
  });

  it("rejects recruiter fields when recruiterVerified is false", () => {
    expect(() => parseProfilePatch({ roleTitle: "CEO" }, true, false)).toThrowError(
      ProfileInputError,
    );
    try {
      parseProfilePatch({ roleTitle: "CEO" }, true, false);
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_scope_violation");
      expect((e as ProfileInputError).details?.requiredRole).toBe("recruiter");
    }
  });

  it("rejects protected fields with profile_protected_fields", () => {
    try {
      parseProfilePatch({ email: "x@example.com" }, true, true);
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_protected_fields");
    }
  });

  it("rejects unknown fields with profile_invalid_fields", () => {
    try {
      parseProfilePatch({ unknownField: "value" }, true, true);
    } catch (e) {
      expect((e as ProfileInputError).code).toBe("profile_invalid_fields");
    }
  });

  it("validates graduationYear range", () => {
    expect(() => parseProfilePatch({ graduationYear: 1800 }, true, true)).toThrowError(
      ProfileInputError,
    );
    expect(() => parseProfilePatch({ graduationYear: 2050 }, true, true)).toThrowError(
      ProfileInputError,
    );
    const patch = parseProfilePatch({ graduationYear: 2024 }, true, true);
    expect(patch.graduationYear).toBe(2024);
  });

  it("validates websiteUrl format", () => {
    expect(() =>
      parseProfilePatch({ websiteUrl: "not-a-url" }, true, true),
    ).toThrowError(ProfileInputError);
    const patch = parseProfilePatch({ websiteUrl: "https://example.com" }, true, true);
    expect(patch.websiteUrl).toBe("https://example.com");
  });

  it("clears optional fields on null input", () => {
    const patch = parseProfilePatch({ bio: null, location: null }, true, true);
    expect(patch.bio).toBeNull();
    expect(patch.location).toBeNull();
  });
});
