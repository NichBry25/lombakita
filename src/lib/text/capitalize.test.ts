import { describe, expect, it } from "vitest";
import { capitalizeFirst, formatDisplayToken } from "@/lib/text/capitalize";

describe("display capitalization", () => {
  it("capitalizes the first character without rewriting the remaining copy", () => {
    expect(capitalizeFirst("draft")).toBe("Draft");
    expect(capitalizeFirst("title is required")).toBe("Title is required");
    expect(capitalizeFirst("")).toBe("");
  });

  it("turns unknown storage tokens into sentence-case display fallbacks", () => {
    expect(formatDisplayToken("pending_review")).toBe("Pending review");
    expect(formatDisplayToken("member.role_changed")).toBe("Member role changed");
    expect(formatDisplayToken("registrationEndAt")).toBe("Registration end at");
    expect(formatDisplayToken("  platform_ops  ")).toBe("Platform ops");
  });
});
