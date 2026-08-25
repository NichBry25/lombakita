// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  RESERVED_RECIPIENT_TLDS,
  ReservedRecipientError,
  assertRecipientIsRoutable,
  reservedTldOf,
} from "./reserved-recipients";

describe("reserved recipient TLDs", () => {
  // DECLARED == ENFORCED. The list is the instrument's statement about its own subject, and a
  // declaration nothing compares against is documentation. Every entry must be refused, and
  // refusal must reach no TLD the list does not name.
  it.each(RESERVED_RECIPIENT_TLDS)("refuses a recipient at .%s", (tld) => {
    expect(reservedTldOf(`fixture@lombakita.${tld}`)).toBe(tld);
    expect(() => assertRecipientIsRoutable(`fixture@lombakita.${tld}`, "probe")).toThrow(
      ReservedRecipientError,
    );
  });

  it("declares exactly the TLDs reserved by RFC 2606 and RFC 6762", () => {
    expect([...RESERVED_RECIPIENT_TLDS].sort()).toEqual([
      "example",
      "invalid",
      "local",
      "localhost",
      "test",
    ]);
  });

  it.each(["candidate@gmail.com", "ops@lombakita.com", "a@sub.domain.co.id", "x@localhost.com"])(
    "allows the routable address %s",
    (address) => {
      expect(reservedTldOf(address)).toBeNull();
      expect(() => assertRecipientIsRoutable(address, "probe")).not.toThrow();
    },
  );

  it("refuses the seeded fixture addresses this codebase actually creates", () => {
    // The two the seed matrix uses. Named rather than generated, so a rename of either has to be
    // made here deliberately instead of passing because the pattern still matches something.
    expect(reservedTldOf("candidate-01@seed.lombakita.local")).toBe("local");
    expect(reservedTldOf("owner@lombakita.local")).toBe("local");
  });

  it("reads the TLD, not a substring of the address", () => {
    // `.local` inside a label is routable; only the final label decides.
    expect(reservedTldOf("local@localhost.example.com")).toBeNull();
    expect(reservedTldOf("user@my.test.com")).toBeNull();
  });

  it("refuses a bare host with no dot at all", () => {
    expect(reservedTldOf("root@localhost")).toBe("localhost");
  });

  it.each([
    ["uppercase", "Fixture@Lombakita.LOCAL"],
    ["a trailing root dot", "fixture@lombakita.local."],
    ["surrounding space", "fixture@ lombakita.local "],
  ])("normalises %s before deciding", (_label, address) => {
    expect(reservedTldOf(address)).toBe("local");
  });

  it("treats an address with no @ as nothing it can judge", () => {
    expect(reservedTldOf("not-an-address")).toBeNull();
  });

  it("names the TLD and the message kind in the refusal", () => {
    try {
      assertRecipientIsRoutable("fixture@lombakita.local", "registration_verification");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ReservedRecipientError);
      expect((error as ReservedRecipientError).tld).toBe("local");
      expect((error as ReservedRecipientError).kind).toBe("registration_verification");
    }
  });
});
