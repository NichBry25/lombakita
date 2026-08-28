import { NextResponse } from "next/server";
import { probeDatabase } from "@/server/db/probe";
import { probeRedis } from "@/server/redis/probe";
import { probeMeilisearch } from "@/server/search/probe";
import { probeR2 } from "@/server/storage/probe";

type CheckStatus = "ok" | "error";

type HealthResponse = {
  status: "ok" | "degraded";
  checks: Record<HealthCheckName, CheckStatus>;
};

// Object storage is checked here because this endpoint reported `ok` throughout an outage in which
// every upload returned 500: R2 was broken and nothing in the response said so. Email, Sentry and
// worker liveness deliberately stay out — this endpoint is unauthenticated, and those probes
// respectively cost an API call, prove only a string's format, and enqueue a real job. They are
// reached through `npm run connectors:status` instead.
const HEALTH_PROBES = {
  db: probeDatabase,
  redis: probeRedis,
  meilisearch: probeMeilisearch,
  r2: probeR2,
} as const;

type HealthCheckName = keyof typeof HEALTH_PROBES;

const HEALTH_CHECK_NAMES = Object.keys(HEALTH_PROBES) as HealthCheckName[];

const runProbe = async (
  name: HealthCheckName,
): Promise<readonly [HealthCheckName, CheckStatus]> => {
  try {
    await HEALTH_PROBES[name]();
    return [name, "ok"] as const;
  } catch {
    return [name, "error"] as const;
  }
};

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const results = await Promise.all(HEALTH_CHECK_NAMES.map(runProbe));
  const checks = Object.fromEntries(results) as Record<HealthCheckName, CheckStatus>;

  const allOk = HEALTH_CHECK_NAMES.every((name) => checks[name] === "ok");

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  );
}
