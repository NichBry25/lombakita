import { describe, expect, it } from "vitest";
import { errorMessageFor } from "./error-copy";

describe("errorMessageFor", () => {
  it("returns the surface copy over the shared copy for the same code", () => {
    const message = errorMessageFor("forbidden", { forbidden: "Surface." }, "Fallback.");

    expect(message).toBe("Surface.");
  });

  it("returns the shared copy for a shared code the surface does not hold", () => {
    const message = errorMessageFor("unauthenticated", {}, "Fallback.");

    expect(message).toBe("Sesi Anda sudah berakhir. Masuk kembali lalu coba lagi.");
  });

  it("returns the fallback for a code without copy", () => {
    const message = errorMessageFor("unmapped_refusal_code", {}, "Fallback.");

    expect(message).toBe("Fallback.");
  });

  it("returns the fallback when there is no code", () => {
    const message = errorMessageFor(null, {}, "Fallback.");

    expect(message).toBe("Fallback.");
  });
});
