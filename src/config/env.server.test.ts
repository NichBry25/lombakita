// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveAppEnvironment, resolvePublicAppUrl } from "@/config/env";
import { buildServerEnv, getRuntimeEnvValidation } from "@/config/env.server";

const baseEnv = {
  NODE_ENV: "development",
  APP_ENV: "local",
  NEXT_PUBLIC_APP_ENV: "local",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/lombakita",
  AUTH_SECRET: "secret",
} satisfies NodeJS.ProcessEnv;

/**
 * A URL value these resolvers must read as ABSENT.
 *
 * `undefined` cannot say that. Every URL option is resolved `options?.x ?? process.env.X`, so an
 * explicitly-passed `undefined` falls through to the ambient environment, and a developer whose
 * `.env.local` sets `NEXT_PUBLIC_APP_URL` gets a different answer from CI on the same assertion —
 * which is how these tests came to fail locally and pass in CI (LAUNCH-D159). The empty string is a
 * SUPPLIED value that `read` normalises to nothing, so it reaches the branch the test is about.
 */
const ABSENT = "";

describe("env runtime validation", () => {
  it("requires core web keys in staging", () => {
    const env = buildServerEnv({
      ...baseEnv,
      APP_ENV: "staging",
      NEXT_PUBLIC_APP_ENV: "staging",
      NEXT_PUBLIC_APP_URL: ABSENT,
      AUTH_URL: ABSENT,
      APP_BASE_URL: ABSENT,
      VERCEL_URL: ABSENT,
    });

    const validation = getRuntimeEnvValidation("web", env);

    expect(validation.requiredKeys).toContain("DATABASE_URL");
    expect(validation.requiredKeys).toContain("AUTH_SECRET");
    expect(validation.missingKeys).toContain(
      "APP_BASE_URL|AUTH_URL|NEXT_PUBLIC_APP_URL|VERCEL_URL",
    );
  });

  it("accepts staging web config when base URL is present", () => {
    const env = buildServerEnv({
      ...baseEnv,
      APP_ENV: "staging",
      NEXT_PUBLIC_APP_ENV: "staging",
      APP_BASE_URL: "https://staging.lombakita.com",
    });

    const validation = getRuntimeEnvValidation("web", env);

    expect(validation.missingKeys).toEqual([]);
  });

  it("requires worker runtime target outside local", () => {
    const env = buildServerEnv({
      ...baseEnv,
      APP_ENV: "staging",
      NEXT_PUBLIC_APP_ENV: "staging",
      REDIS_URL: undefined,
      WORKER_RUNTIME_TARGET: "pending_selection",
    });

    const validation = getRuntimeEnvValidation("worker", env);

    expect(validation.missingKeys).toContain("REDIS_URL");
    expect(validation.missingKeys).toContain("WORKER_RUNTIME_TARGET");
  });
});

describe("public env helpers", () => {
  it("resolves local fallback url for local env", () => {
    const appEnv = resolveAppEnvironment("local");
    const appUrl = resolvePublicAppUrl({ appEnv, explicitUrl: ABSENT, vercelUrl: ABSENT });

    expect(appUrl).toBe("http://localhost:3000");
  });

  it("avoids localhost fallback for staging when no url is configured", () => {
    const appEnv = resolveAppEnvironment("staging");
    const appUrl = resolvePublicAppUrl({ appEnv, explicitUrl: ABSENT, vercelUrl: ABSENT });

    expect(appUrl).toBeUndefined();
  });
});
