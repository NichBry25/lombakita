// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEPLOY_ENV_KEY_SPECS,
  findDeployConfigProblems,
  type DeployConfigProblem,
} from "@/config/env-shape";

const ACCOUNT_ID = "a".repeat(32);

const wellFormedEnv = (): Record<string, string> => ({
  DATABASE_URL: "postgresql://user:pass@ep-cool-1.ap-southeast-1.aws.neon.tech/lombakita",
  AUTH_SECRET: "x".repeat(44),
  REDIS_URL: "redis://default:secret@caboose.proxy.rlwy.net:29765",
  MEILISEARCH_HOST: "https://meilisearch-production.up.railway.app",
  MEILISEARCH_API_KEY: "b".repeat(64),
  R2_ENDPOINT: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  R2_BUCKET: "lombakita-prod",
  R2_ACCESS_KEY_ID: "c".repeat(32),
  R2_SECRET_ACCESS_KEY: "d".repeat(64),
  RESEND_API_KEY: "re_abcdef123456",
  AUTH_EMAIL_FROM: "noreply@auth.lombakita.com",
  APP_BASE_URL: "https://lombakita.com",
  AUTH_URL: "https://lombakita.com",
  NEXT_PUBLIC_APP_URL: "https://lombakita.com",
  GOOGLE_CLIENT_ID: "879773801478-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-abcdefghijklmnop",
  SENTRY_DSN: "https://key@o1.ingest.sentry.io/2",
  NEXT_PUBLIC_SENTRY_DSN: "https://key@o1.ingest.sentry.io/2",
  MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
});

const errorsIn = (problems: DeployConfigProblem[]): DeployConfigProblem[] =>
  problems.filter((problem) => problem.severity === "error");

const problemFor = (
  problems: DeployConfigProblem[],
  key: string,
): DeployConfigProblem | undefined => problems.find((problem) => problem.key === key);

describe("findDeployConfigProblems", () => {
  it("reports nothing for a fully provisioned production environment", () => {
    expect(findDeployConfigProblems(wellFormedEnv(), "production")).toEqual([]);
  });

  // The exact fault that shipped: the whole `.env` line pasted into Vercel's value field. It is a
  // non-empty string, so isR2Available() passed it and uploads threw 500 instead of degrading.
  it("catches a value that repeats its own variable name", () => {
    const env = {
      ...wellFormedEnv(),
      R2_ENDPOINT: `R2_ENDPOINT=https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    };

    const problem = problemFor(findDeployConfigProblems(env, "production"), "R2_ENDPOINT");

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("repeats its own variable name");
  });

  // The Railway fault: a literal <account-id> that cleared every presence check.
  it("catches an unsubstituted angle-bracket placeholder", () => {
    const env = {
      ...wellFormedEnv(),
      R2_ENDPOINT: "https://<account-id>.r2.cloudflarestorage.com",
    };

    const problem = problemFor(findDeployConfigProblems(env, "production"), "R2_ENDPOINT");

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("<account-id>");
  });

  it.each([
    ["replace-me", "R2_ACCESS_KEY_ID"],
    ["placeholder", "R2_BUCKET"],
  ])("catches the %s placeholder token", (token, key) => {
    const problem = problemFor(
      findDeployConfigProblems({ ...wellFormedEnv(), [key]: token }, "production"),
      key,
    );

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("placeholder");
  });

  it("catches quote wrapping and stray whitespace", () => {
    const env = {
      ...wellFormedEnv(),
      R2_BUCKET: '"lombakita-prod"',
      MEILISEARCH_API_KEY: ` ${"b".repeat(64)} `,
    };

    const problems = findDeployConfigProblems(env, "production");

    expect(problemFor(problems, "R2_BUCKET")?.problem).toContain("wrapped in quotes");
    expect(problemFor(problems, "MEILISEARCH_API_KEY")?.problem).toContain("whitespace");
  });

  it.each([
    ["DATABASE_URL", "mysql://user:pass@host/db"],
    ["DATABASE_URL", "postgresql://user:pass@host"],
    ["REDIS_URL", "http://host:6379"],
    ["R2_ENDPOINT", "https://lombakita-prod.r2.cloudflarestorage.com"],
    ["R2_ACCESS_KEY_ID", "not-hex"],
    ["R2_SECRET_ACCESS_KEY", "c".repeat(32)],
    ["RESEND_API_KEY", "abcdef123456"],
    ["MEILISEARCH_HOST", "meilisearch.railway.app"],
    ["APP_BASE_URL", "https://lombakita.com/app"],
    ["AUTH_URL", "http://lombakita.com"],
    ["AUTH_SECRET", "too-short"],
    ["AUTH_EMAIL_FROM", "noreply"],
    ["AUTH_EMAIL_FROM", "noreply@localhost"],
    ["AUTH_EMAIL_FROM", "noreply@auth.lombakita.com, ops@lombakita.com"],
  ])("rejects a malformed %s", (key, value) => {
    const problem = problemFor(
      findDeployConfigProblems({ ...wellFormedEnv(), [key]: value }, "production"),
      key,
    );

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("does not look like");
  });

  it.each([["noreply@auth.lombakita.com"], ["noreply@preview-auth.lombakita.com"]])(
    "accepts %s as a sender",
    (value) => {
      const problems = findDeployConfigProblems(
        { ...wellFormedEnv(), AUTH_EMAIL_FROM: value },
        "production",
      );

      expect(problemFor(problems, "AUTH_EMAIL_FROM")).toBeUndefined();
    },
  );

  // Resend accepts a display name, but the placeholder check owns angle brackets and runs first.
  // Pinned so the interaction is a documented refusal rather than a surprise during a deploy.
  it("refuses a display-name sender, as a placeholder rather than a shape failure", () => {
    const problem = problemFor(
      findDeployConfigProblems(
        { ...wellFormedEnv(), AUTH_EMAIL_FROM: "Lombakita <noreply@auth.lombakita.com>" },
        "production",
      ),
      "AUTH_EMAIL_FROM",
    );

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("placeholder");
  });

  it("treats a missing required key as an error", () => {
    const env = wellFormedEnv();
    delete env.R2_BUCKET;

    expect(problemFor(findDeployConfigProblems(env, "production"), "R2_BUCKET")).toEqual({
      key: "R2_BUCKET",
      severity: "error",
      problem: "not set",
    });
  });

  it("treats an empty string exactly as an absent value", () => {
    const env = { ...wellFormedEnv(), R2_BUCKET: "" };

    expect(problemFor(findDeployConfigProblems(env, "production"), "R2_BUCKET")?.problem).toBe(
      "not set",
    );
  });

  // Preview resolves its base URL from VERCEL_URL per deployment, so absence there is correct.
  it("requires a base URL in production but not in preview", () => {
    const env = wellFormedEnv();
    delete env.APP_BASE_URL;
    delete env.AUTH_URL;

    expect(problemFor(findDeployConfigProblems(env, "production"), "APP_BASE_URL")?.severity).toBe(
      "error",
    );
    expect(problemFor(findDeployConfigProblems(env, "preview"), "APP_BASE_URL")?.severity).toBe(
      "warning",
    );
  });

  it("warns without failing when optional integrations are absent", () => {
    const env = wellFormedEnv();
    delete env.GOOGLE_CLIENT_ID;
    delete env.GOOGLE_CLIENT_SECRET;
    delete env.SENTRY_DSN;
    delete env.NEXT_PUBLIC_SENTRY_DSN;

    const problems = findDeployConfigProblems(env, "production");

    expect(errorsIn(problems)).toEqual([]);
    expect(problems.map((problem) => problem.key)).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]);
  });

  it("catches an MFA_SECRET_ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    const env = {
      ...wellFormedEnv(),
      MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
    };

    const problem = problemFor(
      findDeployConfigProblems(env, "production"),
      "MFA_SECRET_ENCRYPTION_KEY",
    );

    expect(problem?.severity).toBe("error");
    expect(problem?.problem).toContain("32 raw bytes");
  });

  // A gate that inspects nothing passes everything. This pins the inspected set so a spec deleted
  // by accident fails here rather than silently narrowing the gate.
  it("inspects every key the deployed web runtime depends on", () => {
    expect(DEPLOY_ENV_KEY_SPECS.map((spec) => spec.key)).toEqual([
      "DATABASE_URL",
      "AUTH_SECRET",
      "REDIS_URL",
      "MEILISEARCH_HOST",
      "MEILISEARCH_API_KEY",
      "R2_ENDPOINT",
      "R2_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "RESEND_API_KEY",
      "AUTH_EMAIL_FROM",
      "APP_BASE_URL",
      "AUTH_URL",
      "NEXT_PUBLIC_APP_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
      "MFA_SECRET_ENCRYPTION_KEY",
    ]);
  });
});
