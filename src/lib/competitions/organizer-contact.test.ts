// @vitest-environment node

import { describe, expect, it } from "vitest";
import { organizerContactKindEnum } from "@/server/db/schema";
import {
  ORGANIZER_CONTACT_KINDS,
  buildOrganizerContactHref,
  formatOrganizerContactValue,
  toDialDigits,
  toOrganizerContact,
} from "./organizer-contact";

describe("the organiser contact", () => {
  it("lists the same kinds as the database enum", () => {
    expect(ORGANIZER_CONTACT_KINDS).toEqual(organizerContactKindEnum.enumValues);
  });

  it("reads a leading 0 as 62 and drops every other character", () => {
    expect(toDialDigits("0812-3456-7890")).toBe("6281234567890");
    expect(toDialDigits(" +62 812 3456 7890 ")).toBe("6281234567890");
  });

  it("keeps a number written with + and its own country code", () => {
    expect(toDialDigits("+1 555 123 4567")).toBe("15551234567");
  });

  it("gives no digits for a number that names no country", () => {
    expect(toDialDigits("1234 5678")).toBeNull();
  });

  it("reads every way of writing an Indonesian number as one number", () => {
    for (const written of [
      "0812 3456 7890",
      "62812 3456 7890",
      "+62 812 3456 7890",
      "+62 0812 3456 7890",
      "0062 812 3456 7890",
      "81234567890",
    ]) {
      expect(toDialDigits(written)).toBe("6281234567890");
    }
    expect(toDialDigits("021-555-1234")).toBe("62215551234");
    expect(toDialDigits("+1 415 555 0100")).toBe("14155550100");
    expect(toDialDigits("")).toBeNull();
    expect(toDialDigits("12345")).toBeNull();
  });

  it("builds a WhatsApp chat, a call and an email link", () => {
    expect(buildOrganizerContactHref({ kind: "whatsapp", value: "6281234567890" })).toBe(
      "https://wa.me/6281234567890",
    );
    expect(buildOrganizerContactHref({ kind: "phone", value: "6281234567890" })).toBe(
      "tel:+6281234567890",
    );
    expect(buildOrganizerContactHref({ kind: "email", value: "panitia@example.test" })).toBe(
      "mailto:panitia@example.test",
    );
  });

  it("shows a number with + and an email as stored", () => {
    expect(formatOrganizerContactValue({ kind: "whatsapp", value: "6281234567890" })).toBe(
      "+6281234567890",
    );
    expect(formatOrganizerContactValue({ kind: "email", value: "panitia@example.test" })).toBe(
      "panitia@example.test",
    );
  });

  it("joins the two stored columns into one contact, or none", () => {
    expect(toOrganizerContact("phone", "6281234567890")).toEqual({
      kind: "phone",
      value: "6281234567890",
    });
    expect(toOrganizerContact(null, null)).toBeNull();
  });
});
