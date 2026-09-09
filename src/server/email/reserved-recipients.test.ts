// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  RESERVED_RECIPIENT_DOMAINS,
  RESERVED_RECIPIENT_TLDS,
  ReservedRecipientError,
  assertRecipientIsRoutable,
  reservedRecipientSuffixOf,
} from "./reserved-recipients";

describe("reserved recipient TLDs", () => {
  // DECLARED == ENFORCED. The list is the instrument's statement about its own subject, and a
  // declaration nothing compares against is documentation. Every entry must be refused, and
  // refusal must reach no TLD the list does not name.
  it.each(RESERVED_RECIPIENT_TLDS)("refuses a recipient at .%s", (tld) => {
    expect(reservedRecipientSuffixOf(`fixture@lombakita.${tld}`)).toBe(tld);
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
      expect(reservedRecipientSuffixOf(address)).toBeNull();
      expect(() => assertRecipientIsRoutable(address, "probe")).not.toThrow();
    },
  );

  it("refuses the seeded fixture addresses this codebase actually creates", () => {
    // The two the seed matrix uses. Named rather than generated, so a rename of either has to be
    // made here deliberately instead of passing because the pattern still matches something.
    expect(reservedRecipientSuffixOf("candidate-01@seed.lombakita.local")).toBe("local");
    expect(reservedRecipientSuffixOf("owner@lombakita.local")).toBe("local");
  });

  it("reads the final label, not a substring of the address", () => {
    // `.local` inside a label decides nothing; only the final label does.
    expect(reservedRecipientSuffixOf("user@my.test.com")).toBeNull();
    expect(reservedRecipientSuffixOf("user@testing.com")).toBeNull();
  });

  // RFC 2606 §3 reserves these as SECOND-LEVEL names, which a TLD-only check cannot see: they end
  // in `.com`/`.net`/`.org` like any deliverable address. The guard called them routable until
  // this was added, and they are the addresses documentation reaches for by default.
  it.each(RESERVED_RECIPIENT_DOMAINS)("refuses a recipient at %s", (domain) => {
    expect(reservedRecipientSuffixOf(`fixture@${domain}`)).toBe(domain);
    expect(() => assertRecipientIsRoutable(`fixture@${domain}`, "probe")).toThrow(
      ReservedRecipientError,
    );
  });

  it("refuses a subdomain of a reserved second-level name too", () => {
    // Nothing beneath example.com resolves either.
    expect(reservedRecipientSuffixOf("local@localhost.example.com")).toBe("example.com");
    expect(reservedRecipientSuffixOf("a@mail.example.org")).toBe("example.org");
  });

  it("declares exactly the second-level names reserved by RFC 2606", () => {
    expect([...RESERVED_RECIPIENT_DOMAINS].sort()).toEqual([
      "example.com",
      "example.net",
      "example.org",
    ]);
  });

  it("does not over-reach to names that merely start with example", () => {
    // `example.co.id` and `examples.com` are ordinary registrable domains.
    expect(reservedRecipientSuffixOf("a@example.co.id")).toBeNull();
    expect(reservedRecipientSuffixOf("a@examples.com")).toBeNull();
    expect(reservedRecipientSuffixOf("a@notexample.com")).toBeNull();
  });

  it("refuses a bare host with no dot at all", () => {
    expect(reservedRecipientSuffixOf("root@localhost")).toBe("localhost");
  });

  it.each([
    ["uppercase", "Fixture@Lombakita.LOCAL"],
    ["a trailing root dot", "fixture@lombakita.local."],
    ["surrounding space", "fixture@ lombakita.local "],
  ])("normalises %s before deciding", (_label, address) => {
    expect(reservedRecipientSuffixOf(address)).toBe("local");
  });

  it("treats an address with no @ as nothing it can judge", () => {
    expect(reservedRecipientSuffixOf("not-an-address")).toBeNull();
  });

  it("names the TLD and the message kind in the refusal", () => {
    try {
      assertRecipientIsRoutable("fixture@lombakita.local", "registration_verification");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ReservedRecipientError);
      expect((error as ReservedRecipientError).reservedSuffix).toBe("local");
      expect((error as ReservedRecipientError).kind).toBe("registration_verification");
    }
  });
});
