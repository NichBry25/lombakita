import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { serverEnv } from "@/config/env.server";
import { getR2Client } from "@/server/storage/r2.client";

export const isR2Configured = (): boolean => {
  return Boolean(
    process.env.R2_ENDPOINT &&
    process.env.R2_BUCKET &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY,
  );
};

export const probeR2 = async (): Promise<void> => {
  if (!serverEnv.r2Bucket) {
    throw new Error("R2_BUCKET is not configured");
  }

  const client = getR2Client();
  await client.send(
    new HeadBucketCommand({
      Bucket: serverEnv.r2Bucket,
    }),
  );
};
