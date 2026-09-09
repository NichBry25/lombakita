// A 403 AND A TRANSIENT FAILURE MUST NOT READ THE SAME TO THE PERSON LOOKING AT THE SCREEN.
//
// Classification is worth nothing if every class renders identical wording: the operator would be
// told "gagal terkirim" for a misconfiguration that will never clear on its own, and would keep
// retrying. So the distinguishability is asserted as a property of the rendered strings rather than
// of the class names, which is where it actually has to hold.

import { describe, expect, it } from "vitest";
import { emailDeliveryWarning } from "@/lib/email/delivery-notice";

describe("emailDeliveryWarning", () => {
  it("says nothing when the email went out", () => {
    expect(emailDeliveryWarning({ delivered: true })).toBeNull();
  });

  it("says nothing when no email was due", () => {
    expect(emailDeliveryWarning(null)).toBeNull();
    expect(emailDeliveryWarning(undefined)).toBeNull();
  });

  it("renders a distinct message for each failure class", () => {
    const forbidden = emailDeliveryWarning({ delivered: false, failureClass: "forbidden" });
    const transient = emailDeliveryWarning({ delivered: false, failureClass: "transient" });
    const reserved = emailDeliveryWarning({
      delivered: false,
      failureClass: "reserved_recipient",
    });

    expect(forbidden).not.toBeNull();
    expect(transient).not.toBeNull();
    expect(reserved).not.toBeNull();

    expect(new Set([forbidden, transient, reserved]).size).toBe(3);
  });

  it("tells the reader NOT to retry a rejected sending identity", () => {
    const forbidden = emailDeliveryWarning({ delivered: false, failureClass: "forbidden" });

    // The whole point of separating this class: retrying cannot clear it, so the copy must not
    // invite a retry the way the transient copy does.
    expect(forbidden).toMatch(/tidak akan membantu/);
    expect(forbidden).not.toMatch(/Coba kirim ulang/);
  });

  it("still warns when the class is missing or unrecognised, rather than staying silent", () => {
    // Failing open to silence would hide a failed send behind a success message.
    expect(emailDeliveryWarning({ delivered: false })).not.toBeNull();
    expect(
      emailDeliveryWarning({ delivered: false, failureClass: "something_new" }),
    ).not.toBeNull();
  });

  it("reports every message as a qualified success, never as a failed action", () => {
    for (const failureClass of ["forbidden", "transient", "reserved_recipient"]) {
      // The state change already committed. Copy that reads as a failed action would be false.
      expect(emailDeliveryWarning({ delivered: false, failureClass })).toMatch(
        /^Tindakan berhasil/,
      );
    }
  });
});
