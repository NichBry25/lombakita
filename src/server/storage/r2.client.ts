import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/storage/r2.client");

import { S3Client } from "@aws-sdk/client-s3";
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
