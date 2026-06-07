// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseCancelPayload,
  RegistrationError,
  toRegistrationErrorResponse,
} from "./registration-core";

describe("RegistrationError status mapping", () => {
  it.each([
    ["registration_invalid_payload", 400],
    ["competition_not_found", 404],
    ["competition_not_published", 409],
    ["competition_wrong_mode", 409],
    ["registration_deadline_passed", 409],
    ["registration_ineligible", 422],
    ["registration_already_exists", 409],
    ["registration_not_found", 404],
    ["registration_not_owner", 403],
    ["registration_wrong_status", 409],
  ] as const)("maps %s → %i", (code, status) => {
    const err = new RegistrationError(code, "msg");
    expect(err.status).toBe(status);
  });
});

describe("toRegistrationErrorResponse", () => {
  it("serializes error with code, message, and details", async () => {
    const err = new RegistrationError("registration_ineligible", "nope", {
      eligibilityStatus: "incomplete",
    });
    const res = toRegistrationErrorResponse(err);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("registration_ineligible");
    expect(body.error.message).toBe("nope");
    expect(body.error.details).toEqual({ eligibilityStatus: "incomplete" });
  });
});

describe("parseCancelPayload", () => {
  it("treats null/undefined as no reason", () => {
    expect(parseCancelPayload(null)).toEqual({ cancellationReason: null });
    expect(parseCancelPayload(undefined)).toEqual({ cancellationReason: null });
  });

  it("treats empty/whitespace string as null", () => {
    expect(parseCancelPayload({ cancellationReason: "" }).cancellationReason).toBeNull();
    expect(parseCancelPayload({ cancellationReason: "   " }).cancellationReason).toBeNull();
  });

  it("trims a non-empty reason", () => {
    expect(parseCancelPayload({ cancellationReason: "  changed mind  " })).toEqual({
      cancellationReason: "changed mind",
    });
  });

  it("rejects non-object payload", () => {
    expect(() => parseCancelPayload("oops")).toThrow(RegistrationError);
    expect(() => parseCancelPayload([])).toThrow(RegistrationError);
  });

  it("rejects unknown fields", () => {
    expect(() => parseCancelPayload({ foo: "bar" })).toThrow(RegistrationError);
  });

  it("rejects non-string cancellationReason", () => {
    expect(() => parseCancelPayload({ cancellationReason: 42 })).toThrow(RegistrationError);
  });

  it("returns an over-length reason verbatim (length enforced in the service, F12)", () => {
    // parseCancelPayload now does STRUCTURAL validation only; the required-and-length business
    // rules moved into cancelRegistration so the documented check order (ownership → status →
    // reason) holds. The parser returns the trimmed value untouched.
    const long = "a".repeat(501);
    expect(parseCancelPayload({ cancellationReason: long })).toEqual({ cancellationReason: long });
  });
});
