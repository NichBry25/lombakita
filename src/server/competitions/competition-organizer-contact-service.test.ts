// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CompetitionError } from "@/server/competitions/competition-core";
import { parseOrganizerContactInput } from "./competition-organizer-contact-service";

const refusalOf = (payload: unknown): CompetitionError => {
  try {
    parseOrganizerContactInput(payload);
  } catch (error) {
    if (error instanceof CompetitionError) return error;
    throw error;
  }
  throw new Error("the payload was accepted");
};

describe("parseOrganizerContactInput", () => {
  it("stores a WhatsApp number in 62 form", () => {
    expect(parseOrganizerContactInput({ kind: "whatsapp", value: "0812-3456-7890" })).toEqual({
      kind: "whatsapp",
      value: "6281234567890",
    });
  });

  it("stores a Telepon number written with another country code", () => {
    expect(parseOrganizerContactInput({ kind: "phone", value: "+1 555 123 4567" })).toEqual({
      kind: "phone",
      value: "15551234567",
    });
  });

  it("stores an email trimmed and lowercased", () => {
    expect(parseOrganizerContactInput({ kind: "email", value: " Panitia@Example.TEST " })).toEqual({
      kind: "email",
      value: "panitia@example.test",
    });
  });

  it("refuses an empty value, so a saved contact cannot be cleared", () => {
    for (const payload of [
      { kind: "whatsapp", value: "" },
      { kind: "whatsapp", value: "   " },
      { kind: "whatsapp", value: null },
      { kind: "whatsapp" },
    ]) {
      const refusal = refusalOf(payload);
      expect(refusal.code).toBe("competition_organizer_contact_invalid");
      expect(refusal.httpStatus).toBe(400);
      expect(refusal.message).toBe("value is required");
    }
  });

  it("refuses a kind outside WhatsApp, Telepon and Email", () => {
    const refusal = refusalOf({ kind: "line", value: "0812-3456-7890" });
    expect(refusal.code).toBe("competition_organizer_contact_invalid");
    expect(refusal.httpStatus).toBe(400);
  });

  it("refuses a number the host sign-up would refuse", () => {
    for (const value of ["0812-ABC-7890", "1234567"]) {
      const refusal = refusalOf({ kind: "whatsapp", value });
      expect(refusal.code).toBe("competition_organizer_contact_invalid");
      expect(refusal.httpStatus).toBe(400);
    }
  });

  it("refuses a number that names no country", () => {
    const refusal = refusalOf({ kind: "phone", value: "1234 5678" });
    expect(refusal.code).toBe("competition_organizer_contact_invalid");
    expect(refusal.httpStatus).toBe(400);
  });

  it("refuses a WhatsApp number outside Indonesia", () => {
    const refusal = refusalOf({ kind: "whatsapp", value: "+1 555 123 4567" });
    expect(refusal.code).toBe("competition_organizer_contact_not_indonesian");
    expect(refusal.httpStatus).toBe(400);
  });

  it("refuses a WhatsApp contact that is not an Indonesian mobile number", () => {
    for (const value of ["021-555-1234", "+1 415 555 0100", "08123456"]) {
      const refusal = refusalOf({ kind: "whatsapp", value });
      expect(refusal.code).toBe("competition_organizer_contact_not_indonesian");
      expect(refusal.httpStatus).toBe(400);
    }
  });

  it("accepts an Indonesian mobile number written with +62 and a 0", () => {
    expect(parseOrganizerContactInput({ kind: "whatsapp", value: "+62 0812 3456 7890" })).toEqual({
      kind: "whatsapp",
      value: "6281234567890",
    });
  });

  it("refuses a number of fewer than 8 digits", () => {
    const refusal = refusalOf({ kind: "phone", value: "0012 3456" });
    expect(refusal.code).toBe("competition_organizer_contact_invalid");
    expect(refusal.httpStatus).toBe(400);
    expect(refusal.message).toBe("value must have 8 to 15 digits");
  });

  it("refuses a number of more than 15 digits", () => {
    const refusal = refusalOf({ kind: "phone", value: "0812345678901234567" });
    expect(refusal.code).toBe("competition_organizer_contact_invalid");
    expect(refusal.httpStatus).toBe(400);
    expect(refusal.message).toBe("value must have 8 to 15 digits");
  });

  it("refuses an email contact with link characters", () => {
    for (const value of ["panitia@kampus.test?cc=orang%40lain.test", "panitia@kampus.test#x"]) {
      const refusal = refusalOf({ kind: "email", value });
      expect(refusal.code).toBe("competition_organizer_contact_invalid");
      expect(refusal.httpStatus).toBe(400);
    }
  });

  it("refuses an email the host sign-up would refuse", () => {
    const refusal = refusalOf({ kind: "email", value: "panitia@" });
    expect(refusal.code).toBe("competition_organizer_contact_invalid");
    expect(refusal.httpStatus).toBe(400);
  });

  it("refuses a body that is not an object", () => {
    for (const payload of [null, ["whatsapp"]]) {
      const refusal = refusalOf(payload);
      expect(refusal.code).toBe("competition_invalid_payload");
      expect(refusal.httpStatus).toBe(400);
    }
  });
});
