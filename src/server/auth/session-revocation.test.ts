// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isSessionRevoked } from "@/server/auth/session-revocation";

const STAMP = new Date("2026-10-17T10:00:00.000Z");

describe("isSessionRevoked", () => {
  it("does not revoke when the account has no stamp, whatever the token carries", () => {
    expect(isSessionRevoked({ sessionsInvalidBefore: null, tokenSignedInAtMs: 1 })).toBe(false);
    expect(isSessionRevoked({ sessionsInvalidBefore: null, tokenSignedInAtMs: undefined })).toBe(
      false,
    );
  });

  it("revokes a token with no claim once a stamp exists", () => {
    expect(isSessionRevoked({ sessionsInvalidBefore: STAMP, tokenSignedInAtMs: undefined })).toBe(
      true,
    );
  });

  it("revokes a token signed in before the stamp", () => {
    expect(
      isSessionRevoked({ sessionsInvalidBefore: STAMP, tokenSignedInAtMs: STAMP.getTime() - 1 }),
    ).toBe(true);
  });

  it("does not revoke a token signed in at the stamp instant", () => {
    expect(
      isSessionRevoked({ sessionsInvalidBefore: STAMP, tokenSignedInAtMs: STAMP.getTime() }),
    ).toBe(false);
  });

  it("does not revoke a token signed in after the stamp", () => {
    expect(
      isSessionRevoked({ sessionsInvalidBefore: STAMP, tokenSignedInAtMs: STAMP.getTime() + 1 }),
    ).toBe(false);
  });

  it("revokes a token whose claim is not a finite number", () => {
    expect(isSessionRevoked({ sessionsInvalidBefore: STAMP, tokenSignedInAtMs: Number.NaN })).toBe(
      true,
    );
    expect(
      isSessionRevoked({
        sessionsInvalidBefore: STAMP,
        tokenSignedInAtMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
  });

  it("revokes when the stamp is undefined, because the account read did not produce one", () => {
    expect(
      isSessionRevoked({
        sessionsInvalidBefore: undefined as unknown as Date | null,
        tokenSignedInAtMs: STAMP.getTime() + 1,
      }),
    ).toBe(true);
  });

  it("revokes when the stamp is an invalid Date", () => {
    expect(
      isSessionRevoked({
        sessionsInvalidBefore: new Date(Number.NaN),
        tokenSignedInAtMs: STAMP.getTime() + 1,
      }),
    ).toBe(true);
  });
});
