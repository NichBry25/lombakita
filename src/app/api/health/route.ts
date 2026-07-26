import { NextResponse } from "next/server";
import { probeDatabase } from "@/server/db/probe";
import { probeRedis } from "@/server/redis/probe";
import { probeMeilisearch } from "@/server/search/probe";

type CheckStatus = "ok" | "error";

type HealthResponse = {
  status: "ok" | "degraded";
  checks: {
    db: CheckStatus;
    redis: CheckStatus;
    meilisearch: CheckStatus;
  };
};

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const [dbResult, redisResult, meilisearchResult] = await Promise.allSettled([
    probeDatabase(),
    probeRedis(),
    probeMeilisearch(),
  ]);

  const checks = {
    db: dbResult.status === "fulfilled" ? ("ok" as const) : ("error" as const),
    redis: redisResult.status === "fulfilled" ? ("ok" as const) : ("error" as const),
    meilisearch: meilisearchResult.status === "fulfilled" ? ("ok" as const) : ("error" as const),
  };

  const allOk = checks.db === "ok" && checks.redis === "ok" && checks.meilisearch === "ok";

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  );
}
