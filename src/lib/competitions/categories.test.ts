import { describe, expect, it } from "vitest";

import { tagsOtherThanCategory } from "./categories";

describe("tagsOtherThanCategory", () => {
  it("drops a tag spelled like the category, ignoring case and spaces", () => {
    expect(tagsOtherThanCategory(["Hackathon", " hackathon ", "AI"], "Hackathon")).toEqual(["AI"]);
  });

  it("keeps every tag when there is no category", () => {
    expect(tagsOtherThanCategory(["Hackathon"], null)).toEqual(["Hackathon"]);
  });
});
