// @vitest-environment node
//
// THE SIGNING FUNCTION IS TOTAL. The candidate payment view feeds the proof routes, so a refused key
// or missing storage must come back as "unavailable" and never as a throw: a payer who has already
// sent money still has to be able to record the proof.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsR2Available, mockGeneratePresignedGetUrl, mockWarn } = vi.hoisted(() => ({
  mockIsR2Available: vi.fn(),
  mockGeneratePresignedGetUrl: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  isR2Available: mockIsR2Available,
  generatePresignedGetUrl: mockGeneratePresignedGetUrl,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { signQrisImageLink } from "./candidate-payment-qris";

const INSTITUTION_ID = "institution-1";
const OWN_KEY = `payment-instructions/${INSTITUTION_ID}/6f1c2d3e-0000-4000-8000-000000000001`;
const SIGNED_URL = "https://storage.example.test/signed";

beforeEach(() => {
  mockIsR2Available.mockReset();
  mockIsR2Available.mockReturnValue(true);
  mockGeneratePresignedGetUrl.mockReset();
  mockGeneratePresignedGetUrl.mockResolvedValue(SIGNED_URL);
  mockWarn.mockReset();
});

describe("signQrisImageLink", () => {
  it("signs the institution's own key for 3600 seconds as an inline PNG", async () => {
    const result = await signQrisImageLink(OWN_KEY, INSTITUTION_ID);

    expect(result).toEqual({ kind: "shown", url: SIGNED_URL });
    expect(mockGeneratePresignedGetUrl).toHaveBeenCalledTimes(1);
    expect(mockGeneratePresignedGetUrl).toHaveBeenCalledWith(OWN_KEY, 3600, {
      responseContentType: "image/png",
      responseContentDisposition: 'inline; filename="qris.png"',
    });
  });

  it("refuses another institution's key without signing it", async () => {
    const result = await signQrisImageLink(
      "payment-instructions/institution-2/6f1c2d3e-0000-4000-8000-000000000002",
      INSTITUTION_ID,
    );

    expect(result).toEqual({ kind: "unavailable" });
    expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
  });

  it("refuses a key that climbs out of the institution's prefix", async () => {
    const result = await signQrisImageLink(
      `payment-instructions/${INSTITUTION_ID}/../institution-2/object`,
      INSTITUTION_ID,
    );

    expect(result).toEqual({ kind: "unavailable" });
    expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
  });

  it("returns unavailable without signing when storage is not configured", async () => {
    mockIsR2Available.mockReturnValue(false);

    const result = await signQrisImageLink(OWN_KEY, INSTITUTION_ID);

    expect(result).toEqual({ kind: "unavailable" });
    expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
  });

  it("returns unavailable instead of throwing when signing fails, and logs without the key", async () => {
    mockGeneratePresignedGetUrl.mockRejectedValue(new Error("R2_BUCKET is not configured"));

    const result = await signQrisImageLink(OWN_KEY, INSTITUTION_ID);

    expect(result).toEqual({ kind: "unavailable" });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(OWN_KEY);
  });
});
