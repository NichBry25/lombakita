import { describe, expect, it } from "vitest";
import {
  COMPETITION_GUIDELINE_CODES,
  COMPETITION_GUIDELINES,
  competitionGuidelineTextOf,
  isCompetitionGuidelineCode,
} from "./competition-guidelines";

describe("competition guidelines", () => {
  it("lists the ten guideline codes in order, each with one sentence", () => {
    expect(COMPETITION_GUIDELINES.map((guideline) => guideline.code)).toEqual([
      ...COMPETITION_GUIDELINE_CODES,
    ]);
    expect(COMPETITION_GUIDELINE_CODES).toEqual([
      "kontak-nyata",
      "hadiah-jujur",
      "biaya-jelas",
      "bukan-undian",
      "tanpa-kata-sandi",
      "data-secukupnya",
      "bukan-skema-rekrutmen",
      "tanpa-judi",
      "konten-pantas",
      "identitas-benar",
    ]);
    expect(competitionGuidelineTextOf("kontak-nyata")).toBe(
      "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.",
    );
  });

  it("knows only its own codes", () => {
    expect(isCompetitionGuidelineCode("tanpa-judi")).toBe(true);
    expect(isCompetitionGuidelineCode("bukan-pedoman")).toBe(false);
    expect(isCompetitionGuidelineCode("")).toBe(false);
    expect(competitionGuidelineTextOf("bukan-pedoman")).toBeNull();
  });
});
