import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/storage/r2.client");

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serverEnv } from "@/config/env.server";

declare global {
  var __lombakitaR2: S3Client | undefined;
}

const requireR2Config = (): {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
} => {
  const endpoint = serverEnv.r2Endpoint;
  const region = serverEnv.r2Region;
  const accessKeyId = serverEnv.r2AccessKeyId;
  const secretAccessKey = serverEnv.r2SecretAccessKey;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials are not fully configured");
  }

  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
  };
};

const createR2Client = (): S3Client => {
  const config = requireR2Config();

  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
};

export const getR2Client = (): S3Client => {
  if (!globalThis.__lombakitaR2) {
    globalThis.__lombakitaR2 = createR2Client();
  }

  return globalThis.__lombakitaR2;
};

// Step 4.6 — runtime availability gate for the submission upload flow.
// Mirrors the Meilisearch degradation model (`isMeilisearchAvailable`): callers check this
// before attempting any R2 operation and degrade gracefully (HTTP 503, not 500) when storage
// is not configured. Returns true only when every credential needed to mint a presigned URL is
// present — endpoint, bucket, access key, and secret. `r2Region` defaults to "auto" and is not
// required. The endpoint encodes the Cloudflare account id
// (https://<account-id>.r2.cloudflarestorage.com), so no separate account-id variable is needed.
export const isR2Available = (): boolean => {
  return Boolean(
    serverEnv.r2Endpoint &&
      serverEnv.r2Bucket &&
      serverEnv.r2AccessKeyId &&
      serverEnv.r2SecretAccessKey,
  );
};

// Step 4.6 — mint a short-lived presigned PUT URL the browser uses to upload a submission file
// directly to R2. Caller is responsible for checking `isR2Available()` first; this throws if the
// bucket is unconfigured. `ContentType` is bound into the signature only when a mime type is
// provided, so the client must send a matching Content-Type header on the PUT.
export const generatePresignedPutUrl = async (
  fileKey: string,
  fileMimeType: string | null,
  expirySeconds: number,
): Promise<string> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  const command = new PutObjectCommand({
    Bucket: serverEnv.r2Bucket,
    Key: fileKey,
    ContentType: fileMimeType ?? undefined,
  });

  return getSignedUrl(getR2Client(), command, { expiresIn: expirySeconds });
};
