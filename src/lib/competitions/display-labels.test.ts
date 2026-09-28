import { describe, expect, it } from "vitest";

import { getCompetitionCategoryLabel } from "./categories";
import { getCompetitionFieldLabel } from "./fields";
import { getCompetitionModeLabel } from "./modes";
import { COMPETITION_STATUS_LABELS, getCompetitionStatusLabel } from "./status-labels";

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

// MANUAL-D50: the three Indonesian category names this pass supplied. The rest of the map is
// unchanged — `law`, `marketing`, `digital_art`, `infographics` and `performing_arts` still carry
// English words, which is out of this pass's scope and reported rather than fixed.
describe("competition category labels supplied by MANUAL-D50", () => {
  it("names the three categories that were still in English", () => {
    expect(getCompetitionCategoryLabel("business")).toBe("Bisnis");
    expect(getCompetitionCategoryLabel("engineering")).toBe("Teknik");
    expect(getCompetitionCategoryLabel("finance")).toBe("Keuangan");
  });

  it("leaves a name that is already correct in both languages alone", () => {
    expect(getCompetitionCategoryLabel("hackathon")).toBe("Hackathon");
  });
});

// MANUAL-D50: the competition lifecycle status, one home instead of a `capitalizeWord` at each of
// five call sites. Two of those sites rendered "Published" and "Archived" to an Indonesian
// organizer.
describe("COMPETITION_STATUS_LABELS", () => {
  it("names every lifecycle state in Indonesian", () => {
    expect(COMPETITION_STATUS_LABELS).toEqual({
      draft: "Draf",
      published: "Terbit",
      archived: "Diarsipkan",
    });
  });

  it("resolves each stored value to its own label", () => {
    expect(getCompetitionStatusLabel("draft")).toBe("Draf");
    expect(getCompetitionStatusLabel("published")).toBe("Terbit");
    expect(getCompetitionStatusLabel("archived")).toBe("Diarsipkan");
  });

  it("renders nothing for a null or absent status rather than the word 'null'", () => {
    expect(getCompetitionStatusLabel(null)).toBe("");
    expect(getCompetitionStatusLabel(undefined)).toBe("");
    expect(getCompetitionStatusLabel("")).toBe("");
  });

  it("formats an unrecognized value without exposing the raw token", () => {
    // A value from a newer enum this build does not know about must still read as words rather
    // than as `pending_review`.
    expect(getCompetitionStatusLabel("pending_review")).toBe("Pending review");
  });

  it("leaves no label empty, so nothing renders as a blank cell", () => {
    for (const [key, label] of Object.entries(COMPETITION_STATUS_LABELS)) {
      expect(label.trim(), key).not.toBe("");
    }
  });
});
