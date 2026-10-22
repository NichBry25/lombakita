// @vitest-environment node
// Signing tests for r2.client: the real presigner runs with fake credentials, no network, so the
// signed header list is measured rather than mocked.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const fakeEnv = {
  r2Endpoint: "https://account.r2.cloudflarestorage.com",
  r2Region: "auto",
  r2Bucket: "test-bucket",
  r2AccessKeyId: "fake-key-id",
  r2SecretAccessKey: "fake-secret",
};

const loadR2Client = async () => {
  vi.doMock("@/config/env.server", () => ({ serverEnv: fakeEnv }));
  return import("@/server/storage/r2.client");
};

const readSignedHeaders = (signedUrl: string): string[] => {
  const signedHeaders = new URL(signedUrl).searchParams.get("X-Amz-SignedHeaders");
  if (signedHeaders === null) {
    throw new Error("X-Amz-SignedHeaders is missing from the signed URL");
  }
  return signedHeaders.split(";");
};

describe("presigned URL signed headers", () => {
  afterEach(() => {
    delete globalThis.__lombakitaR2;
    vi.resetModules();
  });

  it("generatePresignedPutUrl with a mime type signs content-type and host", async () => {
    const { generatePresignedPutUrl } = await loadR2Client();
    const url = await generatePresignedPutUrl("avatars/user_1/file", "image/png", 900);
    const signedHeaders = readSignedHeaders(url);
    expect(signedHeaders).toContain("content-type");
    expect(signedHeaders).toContain("host");
  });

  it("generatePresignedPutUrl with a null mime type signs only host", async () => {
    const { generatePresignedPutUrl } = await loadR2Client();
    const url = await generatePresignedPutUrl("avatars/user_1/file", null, 900);
    expect(readSignedHeaders(url)).toEqual(["host"]);
  });

  it("generatePresignedGetUrl with no options signs only host", async () => {
    const { generatePresignedGetUrl } = await loadR2Client();
    const url = await generatePresignedGetUrl("avatars/user_1/file", 900);
    expect(readSignedHeaders(url)).toEqual(["host"]);
  });
});
