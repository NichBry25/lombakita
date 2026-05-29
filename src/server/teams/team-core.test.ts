// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildInvitationExpiresAt,
  generateRawToken,
  hashToken,
  maskToken,
  parseTeamCreateInput,
  parseTeamInviteCreateInput,
  parseTeamUpdateInput,
  TEAM_INVITATION_EXPIRY_DAYS,
  TeamError,
  toTeamErrorResponse,
} from "./team-core";

describe("parseTeamCreateInput", () => {
  it("accepts a valid name and trims whitespace", () => {
    expect(parseTeamCreateInput({ name: "  Tim Cemerlang  " })).toEqual({ name: "Tim Cemerlang" });
  });

  it("rejects a name that is too short after trimming", () => {
    expect(() => parseTeamCreateInput({ name: " A " })).toThrow(TeamError);
    try {
      parseTeamCreateInput({ name: "A" });
    } catch (e) {
      expect((e as TeamError).code).toBe("team_invalid_name");
    }
  });

  it("rejects a name that exceeds the max length", () => {
    expect(() => parseTeamCreateInput({ name: "x".repeat(81) })).toThrow(TeamError);
  });

  it("rejects a non-string name", () => {
    expect(() => parseTeamCreateInput({ name: 42 })).toThrow(TeamError);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseTeamCreateInput(null)).toThrow(TeamError);
    expect(() => parseTeamCreateInput("foo")).toThrow(TeamError);
  });
});

describe("parseTeamUpdateInput", () => {
  it("accepts and trims a valid name", () => {
    expect(parseTeamUpdateInput({ name: "Tim Baru" })).toEqual({ name: "Tim Baru" });
  });
});

describe("parseTeamInviteCreateInput", () => {
  it("accepts a valid email and lowercases it", () => {
    expect(parseTeamInviteCreateInput({ invitedEmail: "User@Example.com" })).toEqual({
      invitedEmail: "user@example.com",
    });
  });

  it("rejects an invalid email", () => {
    expect(() => parseTeamInviteCreateInput({ invitedEmail: "not-an-email" })).toThrow(TeamError);
  });

  it("rejects a non-string email", () => {
    expect(() => parseTeamInviteCreateInput({ invitedEmail: null })).toThrow(TeamError);
  });
});

describe("token helpers", () => {
  it("generates a 64-char hex raw token", () => {
    const raw = generateRawToken();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes raw token to a 64-char hex sha256 digest", () => {
    const raw = "a".repeat(64);
    const hashed = hashToken(raw);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(raw);
  });

  it("masks a token to first 8 chars + ellipsis", () => {
    expect(maskToken("abcdefgh_secret_rest_of_token")).toBe("abcdefgh…");
  });

  it("builds an expiry 7 days from the given date", () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    const expiry = buildInvitationExpiresAt(base);
    expect(expiry.getTime() - base.getTime()).toBe(TEAM_INVITATION_EXPIRY_DAYS * 86400_000);
  });
});

describe("TeamError + toTeamErrorResponse", () => {
  it("carries code, message, status, and details", () => {
    const err = new TeamError("team_at_capacity", "full", { maxTeamSize: 4 });
    expect(err.code).toBe("team_at_capacity");
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ maxTeamSize: 4 });
  });

  it("emits an error JSON response with the right status", async () => {
    const err = new TeamError("team_not_found", "missing");
    const res = toTeamErrorResponse(err);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("team_not_found");
  });
});
