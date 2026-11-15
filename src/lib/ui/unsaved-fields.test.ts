import { describe, expect, it } from "vitest";
import { hasUnsavedFields } from "./unsaved-fields";

describe("hasUnsavedFields", () => {
  const saved = { fullName: "Sari Dewi", phone: "0812" };

  it("is false while every value is the saved one", () => {
    expect(hasUnsavedFields({ fullName: "Sari Dewi", phone: "0812" }, saved)).toBe(false);
  });

  it("is true as soon as one value differs", () => {
    expect(hasUnsavedFields({ fullName: "Sari Dewi", phone: "0813" }, saved)).toBe(true);
  });

  it("ignores spaces around a value, which every save trims", () => {
    expect(hasUnsavedFields({ fullName: "  Sari Dewi ", phone: "0812 " }, saved)).toBe(false);
  });

  it("treats a field the saved values lack as empty", () => {
    expect(hasUnsavedFields({ fullName: "Sari Dewi", note: "" }, saved)).toBe(false);
    expect(hasUnsavedFields({ fullName: "Sari Dewi", note: "baru" }, saved)).toBe(true);
  });
});
