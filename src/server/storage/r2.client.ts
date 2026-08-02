import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/storage/r2.client");

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

// Runtime availability gate for the submission upload flow.
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

// Mint a short-lived presigned PUT URL the browser uses to upload a submission file
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

// Mint a short-lived presigned GET URL for reading a private object (profile avatar / resume /
// certificate file). Objects are never public — the read path signs a fresh URL at render time.
// Caller is responsible for checking `isR2Available()` first; this throws if the bucket is
// unconfigured. `responseContentDisposition` and `responseContentType` are bound into the signed
// URL so the served response forces a download (or inline render) with a chosen filename and a
// trusted content type, independent of how the object was stored.
export const generatePresignedGetUrl = async (
  fileKey: string,
  expirySeconds: number,
  options?: { responseContentDisposition?: string; responseContentType?: string },
): Promise<string> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: serverEnv.r2Bucket,
    Key: fileKey,
    ResponseContentDisposition: options?.responseContentDisposition,
    ResponseContentType: options?.responseContentType,
  });

  return getSignedUrl(getR2Client(), command, { expiresIn: expirySeconds });
};

// Reads an object's size and stored content type without transferring its body. Returns null when
// the object does not exist (a presigned upload that never completed). Caller must check
// `isR2Available()` first.
export const headObject = async (
  fileKey: string,
): Promise<{ sizeBytes: number; contentType: string | null } | null> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  try {
    const response = await getR2Client().send(
      new HeadObjectCommand({ Bucket: serverEnv.r2Bucket, Key: fileKey }),
    );
    return {
      sizeBytes: response.ContentLength ?? 0,
      contentType: response.ContentType ?? null,
    };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
};

// Reads only the leading bytes of a stored object via a ranged GET — enough to inspect its
// magic-byte signature without downloading the whole file. Caller must check `isR2Available()`
// first.
export const readObjectHead = async (fileKey: string, maxBytes: number): Promise<Uint8Array> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: serverEnv.r2Bucket,
      Key: fileKey,
      Range: `bytes=0-${maxBytes - 1}`,
    }),
  );

  if (!response.Body) {
    return new Uint8Array(0);
  }

  return response.Body.transformToByteArray();
};

// Removes an object from the bucket. Used to purge a file that failed content validation after
// upload. Caller must check `isR2Available()` first.
export const deleteObject = async (fileKey: string): Promise<void> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  await getR2Client().send(new DeleteObjectCommand({ Bucket: serverEnv.r2Bucket, Key: fileKey }));
};

// Lists every object under a key prefix, following pagination. Used to reconcile the objects
// actually present in storage against the rows that reference them, so orphaned uploads can be
// reclaimed. Caller must check `isR2Available()` first.
export const listObjects = async (
  prefix: string,
): Promise<Array<{ key: string; lastModified: Date | null }>> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  const objects: Array<{ key: string; lastModified: Date | null }> = [];
  let continuationToken: string | undefined;

  do {
    const response = await getR2Client().send(
      new ListObjectsV2Command({
        Bucket: serverEnv.r2Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) {
        objects.push({ key: item.Key, lastModified: item.LastModified ?? null });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
};
