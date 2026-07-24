// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseCompetitionPrizesInput,
  CompetitionPrizesInputError,
} from "@/server/competitions/competition-prizes-core";

describe("parseCompetitionPrizesInput", () => {
  it("parses a valid prize list preserving order", () => {
    const prizes = parseCompetitionPrizesInput({
      prizes: [
        { rankLabel: "Juara 1", title: "Hadiah utama", cashAmount: 5000000, isCertificate: true },
        { title: "Sertifikat peserta", isCertificate: true },
      ],
    });
    expect(prizes).toHaveLength(2);
    expect(prizes[0]).toEqual({
      rankLabel: "Juara 1",
      title: "Hadiah utama",
      description: null,
      cashAmount: "5000000.00",
      isCertificate: true,
    });
    expect(prizes[1]!.cashAmount).toBeNull();
    expect(prizes[1]!.isCertificate).toBe(true);
  });

  it("accepts a numeric string cash amount and formats to 2 decimals", () => {
    const prizes = parseCompetitionPrizesInput({
      prizes: [{ title: "Uang tunai", cashAmount: "1500000.5", isCertificate: false }],
    });
    expect(prizes[0]!.cashAmount).toBe("1500000.50");
  });

  it("rejects a payload without a prizes array", () => {
    expect(() => parseCompetitionPrizesInput({})).toThrow(CompetitionPrizesInputError);
    expect(() => parseCompetitionPrizesInput({ prizes: "nope" })).toThrow(/must be an array/);
  });

  it("rejects more than the maximum number of prizes", () => {
    const many = Array.from({ length: 21 }, () => ({ title: "x", isCertificate: true }));
    expect(() => parseCompetitionPrizesInput({ prizes: many })).toThrow(/at most/);
  });

  it("requires a title on each prize", () => {
    expect(() =>
      parseCompetitionPrizesInput({ prizes: [{ title: "   ", cashAmount: 100 }] }),
    ).toThrow(/title is required/);
  });

  it("rejects a prize with neither cash nor certificate", () => {
    expect(() =>
      parseCompetitionPrizesInput({ prizes: [{ title: "Kosong", isCertificate: false }] }),
    ).toThrow(/cash amount or be a certificate/);
  });

  it("rejects a negative cash amount", () => {
    expect(() => parseCompetitionPrizesInput({ prizes: [{ title: "x", cashAmount: -1 }] })).toThrow(
      /must not be negative/,
    );
  });

  it("allows an empty prize list", () => {
    expect(parseCompetitionPrizesInput({ prizes: [] })).toEqual([]);
  });
});
