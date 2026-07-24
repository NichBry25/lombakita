// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseCompetitionRoundsInput,
  CompetitionRoundsInputError,
} from "@/server/competitions/competition-rounds-core";

describe("parseCompetitionRoundsInput", () => {
  it("parses a valid round list preserving order", () => {
    const rounds = parseCompetitionRoundsInput({
      rounds: [
        {
          title: "Babak 1 - Kuis",
          platformLabel: "Online",
          startsAt: "2026-07-25T12:30:00.000Z",
          endsAt: "2026-07-25T13:00:00.000Z",
          description: "Kuis pilihan ganda.",
        },
        { title: "Final" },
      ],
    });
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.title).toBe("Babak 1 - Kuis");
    expect(rounds[0]!.platformLabel).toBe("Online");
    expect(rounds[0]!.startsAt).toBeInstanceOf(Date);
    expect(rounds[1]!.startsAt).toBeNull();
    expect(rounds[1]!.endsAt).toBeNull();
    expect(rounds[1]!.description).toBeNull();
  });

  it("rejects a payload without a rounds array", () => {
    expect(() => parseCompetitionRoundsInput({})).toThrow(CompetitionRoundsInputError);
    expect(() => parseCompetitionRoundsInput({ rounds: "nope" })).toThrow(/must be an array/);
  });

  it("rejects more than the maximum number of rounds", () => {
    const many = Array.from({ length: 21 }, () => ({ title: "x" }));
    expect(() => parseCompetitionRoundsInput({ rounds: many })).toThrow(/at most/);
  });

  it("requires a title on each round", () => {
    expect(() => parseCompetitionRoundsInput({ rounds: [{ title: "  " }] })).toThrow(
      /title is required/,
    );
  });

  it("rejects an invalid datetime", () => {
    expect(() =>
      parseCompetitionRoundsInput({ rounds: [{ title: "x", startsAt: "not-a-date" }] }),
    ).toThrow(/not a valid datetime/);
  });

  it("rejects endsAt before startsAt", () => {
    expect(() =>
      parseCompetitionRoundsInput({
        rounds: [
          {
            title: "x",
            startsAt: "2026-07-25T13:00:00.000Z",
            endsAt: "2026-07-25T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/must not be before/);
  });

  it("allows an empty round list", () => {
    expect(parseCompetitionRoundsInput({ rounds: [] })).toEqual([]);
  });
});
