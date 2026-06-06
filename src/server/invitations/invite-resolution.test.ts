// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  classifyInviteIdentifier,
  resolveClaimInviteEmailByToken,
  resolveInviteRecipient,
} from "@/server/invitations/invite-resolution";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

// Sequential select results feed `.limit()` in call order.
const makeDb = (selectResults: unknown[][]) => {
  let i = 0;
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      const r = selectResults[i] ?? [];
      i++;
      return Promise.resolve(r);
    }),
  };
};

describe("classifyInviteIdentifier", () => {
  it("classifies an email (lowercased)", () => {
    expect(classifyInviteIdentifier("User@Example.com")).toEqual({
      kind: "email",
      value: "user@example.com",
    });
  });

  it("classifies a username (lowercased)", () => {
    expect(classifyInviteIdentifier("Budi_Santoso")).toEqual({
      kind: "username",
      value: "budi_santoso",
    });
  });

  it("rejects empty / malformed input", () => {
    expect(classifyInviteIdentifier("")).toBeNull();
    expect(classifyInviteIdentifier("   ")).toBeNull();
    expect(classifyInviteIdentifier("not an email")).toBeNull(); // space → not username, no @
    expect(classifyInviteIdentifier("bad@")).toBeNull(); // looks like email, fails pattern
    expect(classifyInviteIdentifier("ab")).toBeNull(); // username too short
    expect(classifyInviteIdentifier(42)).toBeNull();
  });
});

describe("resolveInviteRecipient", () => {
  it("email with an existing VERIFIED account → targeted", async () => {
    const db = makeDb([[{ id: "user_1" }]]);
    await expect(
      resolveInviteRecipient({ kind: "email", value: "a@b.com" }, db as never),
    ).resolves.toEqual({ mode: "targeted", targetUserId: "user_1", invitedEmail: "a@b.com" });
  });

  it("email with no verified account → pending_claim (null target)", async () => {
    const db = makeDb([[]]);
    await expect(
      resolveInviteRecipient({ kind: "email", value: "nobody@b.com" }, db as never),
    ).resolves.toEqual({ mode: "pending_claim", invitedEmail: "nobody@b.com" });
  });

  it("username that resolves to an account → targeted (uses the account's own email)", async () => {
    const db = makeDb([[{ id: "user_2", email: "Owner@B.com" }]]);
    await expect(
      resolveInviteRecipient({ kind: "username", value: "budi" }, db as never),
    ).resolves.toEqual({ mode: "targeted", targetUserId: "user_2", invitedEmail: "owner@b.com" });
  });

  it("username with no matching account → username_not_found", async () => {
    const db = makeDb([[]]);
    await expect(
      resolveInviteRecipient({ kind: "username", value: "ghost" }, db as never),
    ).resolves.toEqual({ mode: "username_not_found" });
  });
});

describe("resolveClaimInviteEmailByToken", () => {
  it("returns the institution pending_claim invited email when the token matches", async () => {
    const db = makeDb([[{ invitedEmail: "claim@b.com" }]]);
    await expect(resolveClaimInviteEmailByToken("rawtoken", db as never)).resolves.toBe(
      "claim@b.com",
    );
  });

  it("falls through to the team table when no institution row matches", async () => {
    const db = makeDb([[], [{ invitedEmail: "team-claim@b.com" }]]);
    await expect(resolveClaimInviteEmailByToken("rawtoken", db as never)).resolves.toBe(
      "team-claim@b.com",
    );
  });

  it("returns null when no pending_claim invite matches in either table", async () => {
    const db = makeDb([[], []]);
    await expect(resolveClaimInviteEmailByToken("rawtoken", db as never)).resolves.toBeNull();
  });
});
