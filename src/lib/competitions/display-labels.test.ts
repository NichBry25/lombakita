import { describe, expect, it } from "vitest";

import { getCompetitionCategoryLabel } from "./categories";
import { getCompetitionFieldLabel } from "./fields";
import { getCompetitionModeLabel } from "./modes";

describe("competition display labels", () => {
  it("localizes the raw values shown in the competition summary", () => {
    expect(getCompetitionModeLabel("individual")).toBe("Individu");
    expect(getCompetitionCategoryLabel("other")).toBe("Lainnya");
    expect(getCompetitionFieldLabel("registrationStartAt")).toBe("Pendaftaran mulai");
  });

  it("formats unknown legacy values without exposing raw tokens", () => {
    expect(getCompetitionModeLabel("hybrid_mode")).toBe("Hybrid mode");
    expect(getCompetitionCategoryLabel("digitalProduct")).toBe("Digital product");
    expect(getCompetitionFieldLabel("review_notes")).toBe("Review notes");
  });
});
