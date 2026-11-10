import { describe, expect, it } from "vitest";
import { getCompetitionResumeStep, type CompetitionResumeValues } from "./competition-steps";

const completeForm = (): CompetitionResumeValues => ({
  title: "Lomba Inovasi",
  description: "Deskripsi kompetisi",
  category: "hackathon",
  mode: "individual",
  minTeamSize: "1",
  maxTeamSize: "1",
  registrationStartAt: "2026-08-01T09:00",
  registrationEndAt: "2026-08-10T09:00",
  eventStartAt: "2026-08-15T09:00",
  eventEndAt: "2026-08-16T17:00",
  resultAnnouncementAt: "2026-08-20T09:00",
  participantConfirmationAt: "2026-08-12T09:00",
});

describe("getCompetitionResumeStep", () => {
  it("opens step 5 when nothing is missing", () => {
    expect(getCompetitionResumeStep(completeForm())).toBe(5);
  });

  it.each([
    ["title", 1],
    ["description", 1],
    ["category", 1],
    ["mode", 2],
    ["registrationStartAt", 3],
    ["registrationEndAt", 3],
    ["eventStartAt", 3],
    ["eventEndAt", 3],
    ["resultAnnouncementAt", 3],
    ["participantConfirmationAt", 3],
  ] as const)("sends a missing %s to step %i", (field, step) => {
    expect(getCompetitionResumeStep({ ...completeForm(), [field]: "" })).toBe(step);
  });

  it("opens the first step that holds a missing field", () => {
    const values = { ...completeForm(), description: "", mode: "", eventEndAt: "" };
    expect(getCompetitionResumeStep(values)).toBe(1);
  });

  it.each([
    ["team", "2", ""],
    ["both", "1", ""],
    ["team", "", "2"],
  ])("sends mode %s with min %j and max %j to step 2", (mode, minTeamSize, maxTeamSize) => {
    expect(getCompetitionResumeStep({ ...completeForm(), mode, minTeamSize, maxTeamSize })).toBe(2);
  });

  it("does not send an individual or both-mode draft with its sizes set to step 2", () => {
    expect(
      getCompetitionResumeStep({
        ...completeForm(),
        mode: "both",
        minTeamSize: "",
        maxTeamSize: "3",
      }),
    ).toBe(5);
    expect(
      getCompetitionResumeStep({
        ...completeForm(),
        mode: "individual",
        minTeamSize: "",
        maxTeamSize: "",
      }),
    ).toBe(5);
  });
});
