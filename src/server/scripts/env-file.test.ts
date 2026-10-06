// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  InvalidDeployEnvironmentError,
  buildCandidates,
  parseDeployEnvironment,
  pulledEnvFilePath,
} from "@/server/scripts/env-file";

describe("parseDeployEnvironment", () => {
  it.each(["preview", "production"])("accepts %s", (value) => {
    expect(parseDeployEnvironment(value)).toBe(value);
  });

  it.each([
    ["a value outside the two", "staging"],
    ["a different case", "Preview"],
    ["an empty string", ""],
    ["nothing", undefined],
  ])("throws the typed error, with the fixed message, for %s", (_label, value) => {
    expect(() => parseDeployEnvironment(value)).toThrow(InvalidDeployEnvironmentError);
    expect(() => parseDeployEnvironment(value)).toThrow(
      "--environment must be one of preview | production",
    );
  });

  it("never carries what the caller passed", () => {
    try {
      parseDeployEnvironment("zz-sentinel");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDeployEnvironmentError);
      expect((error as Error).message).toBe("--environment must be one of preview | production");
      expect((error as Error).message).not.toContain("zz-sentinel");
    }
  });
});

describe("the pulled file path", () => {
  it.each(["preview", "production"])("is .vercel/.env.%s.local", (environment) => {
    expect(pulledEnvFilePath(environment)).toBe(`.vercel/.env.${environment}.local`);
  });

  // The overlay writes this path and layer 1, layer 2 and the schema gate read the first candidate;
  // if the two ever diverged, the overlay would fill a file nothing reads.
  it.each(["preview", "production"])(
    "is the first file layer 1 looks for, then .env.local and .env, for %s",
    (environment) => {
      expect(buildCandidates(environment, undefined)).toEqual([
        pulledEnvFilePath(environment),
        ".env.local",
        ".env",
      ]);
    },
  );

  it("is replaced by an explicit path, alone", () => {
    expect(buildCandidates("preview", "/somewhere/pulled.local")).toEqual([
      "/somewhere/pulled.local",
    ]);
  });
});
