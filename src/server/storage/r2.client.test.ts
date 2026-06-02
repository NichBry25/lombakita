// @vitest-environment node
// Step 6.3 — 4.6-D3: r2.client unit tests (isR2Available + generatePresignedPutUrl happy path).

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetSignedUrl } = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mockGetSignedUrl }));

// Env helpers — override serverEnv credentials per test.
const baseEnv = {
  r2Endpoint: "https://account.r2.cloudflarestorage.com",
  r2Region: "auto",
  r2Bucket: "test-bucket",
  r2AccessKeyId: "key-id",
  r2SecretAccessKey: "secret",
};

const applyEnv = (overrides: Partial<typeof baseEnv>) => {
  vi.doMock("@/config/env.server", () => ({
    serverEnv: { ...baseEnv, ...overrides },
  }));
};

describe("isR2Available", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns true when all four credentials are present", async () => {
    applyEnv({});
    const { isR2Available } = await import("@/server/storage/r2.client");
    expect(isR2Available()).toBe(true);
  });

  it("returns false when endpoint is missing", async () => {
    applyEnv({ r2Endpoint: undefined as unknown as string });
    const { isR2Available } = await import("@/server/storage/r2.client");
    expect(isR2Available()).toBe(false);
  });

  it("returns false when bucket is missing", async () => {
    applyEnv({ r2Bucket: undefined as unknown as string });
    const { isR2Available } = await import("@/server/storage/r2.client");
    expect(isR2Available()).toBe(false);
  });

  it("returns false when access key id is missing", async () => {
    applyEnv({ r2AccessKeyId: undefined as unknown as string });
    const { isR2Available } = await import("@/server/storage/r2.client");
    expect(isR2Available()).toBe(false);
  });

  it("returns false when secret access key is missing", async () => {
    applyEnv({ r2SecretAccessKey: undefined as unknown as string });
    const { isR2Available } = await import("@/server/storage/r2.client");
    expect(isR2Available()).toBe(false);
  });
});

describe("generatePresignedPutUrl", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the signed URL from getSignedUrl on the happy path", async () => {
    applyEnv({});
    mockGetSignedUrl.mockResolvedValueOnce("https://signed.url/key");
    const { generatePresignedPutUrl } = await import("@/server/storage/r2.client");
    const url = await generatePresignedPutUrl("submissions/reg_1/file.pdf", "application/pdf", 900);
    expect(url).toBe("https://signed.url/key");
    expect(mockGetSignedUrl).toHaveBeenCalledOnce();
  });

  it("throws when bucket is not configured", async () => {
    applyEnv({ r2Bucket: undefined as unknown as string });
    const { generatePresignedPutUrl } = await import("@/server/storage/r2.client");
    await expect(
      generatePresignedPutUrl("submissions/reg_1/file.pdf", null, 900),
    ).rejects.toThrow("R2_BUCKET is not configured");
  });
});
