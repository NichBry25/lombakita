// @vitest-environment node

import { describe, expect, it } from "vitest";
import { formatTeamSizeText } from "./team-size-utils";

describe("F8 — formatTeamSizeText (team-size display collapse)", () => {
  it("renders a single number when min equals max", () => {
    expect(formatTeamSizeText(4, 4)).toBe("4 orang");
  });

  it("renders a range when min is one below max (off-by-one)", () => {
    expect(formatTeamSizeText(3, 4)).toBe("3–4 orang");
  });

  it("renders a range when max is one above min (off-by-one high side)", () => {
    expect(formatTeamSizeText(4, 5)).toBe("4–5 orang");
  });

  it("renders range when min and max differ by more than one", () => {
    expect(formatTeamSizeText(2, 6)).toBe("2–6 orang");
  });

  it("renders Min. prefix when only min is provided", () => {
    expect(formatTeamSizeText(2, null)).toBe("Min. 2 orang");
  });

  it("renders Maks. prefix when only max is provided", () => {
    expect(formatTeamSizeText(null, 5)).toBe("Maks. 5 orang");
  });

  it("returns empty string when both are null", () => {
    expect(formatTeamSizeText(null, null)).toBe("");
  });
});
