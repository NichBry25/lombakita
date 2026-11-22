import { describe, expect, it } from "vitest";
import { SESSION_MISMATCH_MESSAGE } from "@/lib/session/session-fetch";
import { errorMessageFor, ONBOARDING_FIELD_REFUSAL_COPY, refusalCopyKey } from "./error-copy";

describe("errorMessageFor", () => {
  it("returns the surface copy over the shared copy for the same code", () => {
    const message = errorMessageFor("forbidden", { forbidden: "Surface." }, "Fallback.");

    expect(message).toBe("Surface.");
  });

  it("returns the shared copy for a shared code the surface does not hold", () => {
    const message = errorMessageFor("unauthenticated", {}, "Fallback.");

    expect(message).toBe("Sesi Anda sudah berakhir. Masuk kembali lalu coba lagi.");
  });

  it("returns the session-mismatch sentence for session_user_mismatch", () => {
    const message = errorMessageFor("session_user_mismatch", {}, "Fallback.");

    expect(message).toBe(SESSION_MISMATCH_MESSAGE);
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

describe("refusalCopyKey", () => {
  it("picks the field sentence when the surface copy has one for that field", () => {
    const key = refusalCopyKey(
      "candidate_profile_invalid_value",
      "phoneNumber",
      ONBOARDING_FIELD_REFUSAL_COPY,
    );

    expect(key).toBe("candidate_profile_invalid_value.phoneNumber");
  });

  it("falls back to the code when the field has no sentence", () => {
    const key = refusalCopyKey(
      "candidate_profile_invalid_value",
      "unknownField",
      ONBOARDING_FIELD_REFUSAL_COPY,
    );

    expect(key).toBe("candidate_profile_invalid_value");
  });
});
