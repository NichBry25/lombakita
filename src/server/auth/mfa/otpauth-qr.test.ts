// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderOtpauthQrDataUrl } from "./otpauth-qr";

const OTPAUTH_URI =
  "otpauth://totp/Lombakita%3Aops%40example.com?secret=L3WV53K65VPO2XXNL3WV53K65VPO2XXN&issuer=Lombakita&algorithm=SHA1&digits=6&period=30";

describe("renderOtpauthQrDataUrl", () => {
  it("returns an inline PNG data URI, so the secret never leaves the server", async () => {
    const dataUrl = await renderOtpauthQrDataUrl(OTPAUTH_URI);

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // No http(s) origin anywhere in the value — a third-party chart service would appear here.
    expect(dataUrl).not.toMatch(/https?:\/\//);
  });

  it("encodes the URI it was given, not a fixed image", async () => {
    const [a, b] = await Promise.all([
      renderOtpauthQrDataUrl(OTPAUTH_URI),
      renderOtpauthQrDataUrl(OTPAUTH_URI.replace("L3WV", "AAAA")),
    ]);

    expect(a).not.toEqual(b);
  });

  it("is deterministic for one URI, so a re-render does not change the code on screen", async () => {
    const [a, b] = await Promise.all([
      renderOtpauthQrDataUrl(OTPAUTH_URI),
      renderOtpauthQrDataUrl(OTPAUTH_URI),
    ]);

    expect(a).toEqual(b);
  });
});
