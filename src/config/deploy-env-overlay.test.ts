// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERLAY_NAMES,
  PLAIN_REQUIRED_NAMES,
  hasBlockingOverlayStatus,
  isWritableMirrorValue,
  overlayDeployEnv,
  type OverlayStatus,
} from "@/config/deploy-env-overlay";
import { DEPLOY_ENV_KEY_SPECS } from "@/config/env-shape";

// Every character the writer is allowed to emit unquoted-by-escape: = # % @ ? & + /
const WRITABLE_SENTINEL = "s3cr=et#%@?&+/v4lue";
const OTHER_WRITABLE_SENTINEL = "0th3r=et#%@?&+/v4lue";

const statusOf = (
  pulled: Record<string, string | undefined>,
  mirror: Record<string, string | undefined>,
  name = "DATABASE_URL",
): OverlayStatus | undefined =>
  overlayDeployEnv(pulled, mirror).report.find((entry) => entry.name === name)?.status;

const requiredIn = (environment: "preview" | "production") =>
  DEPLOY_ENV_KEY_SPECS.filter((spec) => spec.requiredIn.includes(environment));

/** Names the gate requires somewhere that appear in neither overlay list. */
const unclassifiedRequiredNames = (
  specs: readonly { key: string; requiredIn: readonly string[] }[],
): string[] =>
  specs
    .filter((spec) => spec.requiredIn.length > 0)
    .map((spec) => spec.key)
    .filter(
      (key) =>
        !(OVERLAY_NAMES as readonly string[]).includes(key) &&
        !(PLAIN_REQUIRED_NAMES as readonly string[]).includes(key),
    );

describe("the two name lists", () => {
  it("OVERLAY_NAMES is exactly the nine secrets", () => {
    expect([...OVERLAY_NAMES].sort()).toEqual(
      [
        "AUTH_SECRET",
        "DATABASE_URL",
        "MEILISEARCH_API_KEY",
        "MFA_SECRET_ENCRYPTION_KEY",
        "MIGRATION_DATABASE_URL",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "REDIS_URL",
        "RESEND_API_KEY",
      ].sort(),
    );
  });

  it("PLAIN_REQUIRED_NAMES is exactly the six non-secret required names", () => {
    expect([...PLAIN_REQUIRED_NAMES].sort()).toEqual(
      [
        "APP_BASE_URL",
        "AUTH_EMAIL_FROM",
        "AUTH_URL",
        "MEILISEARCH_HOST",
        "R2_BUCKET",
        "R2_ENDPOINT",
      ].sort(),
    );
  });

  it("the required counts are still 15 in production and 13 in preview", () => {
    expect(requiredIn("production")).toHaveLength(15);
    expect(requiredIn("preview")).toHaveLength(13);
  });

  it("no name is in both lists", () => {
    const overlap = OVERLAY_NAMES.filter((name) =>
      (PLAIN_REQUIRED_NAMES as readonly string[]).includes(name),
    );

    expect(overlap).toEqual([]);
  });

  // The tripwire: a required spec name that nobody classified is a secret nobody decided about.
  it("every required spec name is in exactly one list", () => {
    expect(unclassifiedRequiredNames(DEPLOY_ENV_KEY_SPECS)).toEqual([]);
  });

  it("every listed name is a required spec name, so neither list goes stale", () => {
    const required = new Set(
      DEPLOY_ENV_KEY_SPECS.filter((s) => s.requiredIn.length > 0).map((s) => s.key),
    );
    const listed = [...OVERLAY_NAMES, ...PLAIN_REQUIRED_NAMES];

    expect(listed.filter((name) => !required.has(name))).toEqual([]);
  });

  it("the classification check does fail when a required spec name is added unclassified", () => {
    const withNewRequiredName = [
      ...DEPLOY_ENV_KEY_SPECS,
      { key: "BRAND_NEW_REQUIRED_KEY", requiredIn: ["production"] as const },
    ];

    expect(unclassifiedRequiredNames(withNewRequiredName)).toEqual(["BRAND_NEW_REQUIRED_KEY"]);
  });
});

describe("overlayDeployEnv statuses", () => {
  it("fills from the mirror when the pulled value is empty", () => {
    const { merged, report } = overlayDeployEnv(
      { DATABASE_URL: "" },
      { DATABASE_URL: WRITABLE_SENTINEL },
    );

    expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
    expect(report.find((e) => e.name === "DATABASE_URL")?.status).toBe("filled-from-github");
  });

  it("fills from the mirror when the pulled value is missing", () => {
    const { merged } = overlayDeployEnv({}, { DATABASE_URL: WRITABLE_SENTINEL });

    expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
    expect(statusOf({}, { DATABASE_URL: WRITABLE_SENTINEL })).toBe("filled-from-github");
  });

  it("leaves equal values unchanged", () => {
    const pulled = { DATABASE_URL: WRITABLE_SENTINEL };
    const { merged } = overlayDeployEnv(pulled, { DATABASE_URL: WRITABLE_SENTINEL });

    expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
    expect(statusOf(pulled, { DATABASE_URL: WRITABLE_SENTINEL })).toBe("equal");
  });

  it("reports drift, and keeps the pulled value, when both are set and differ", () => {
    const pulled = { DATABASE_URL: WRITABLE_SENTINEL };
    const mirror = { DATABASE_URL: OTHER_WRITABLE_SENTINEL };
    const { merged } = overlayDeployEnv(pulled, mirror);

    expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
    expect(statusOf(pulled, mirror)).toBe("drift");
  });

  it.each([
    ["empty", { DATABASE_URL: "" }],
    ["missing", {}],
  ])(
    "is not-mirrored, and unchanged, when the mirror is %s and the pulled value is set",
    (_label, mirror) => {
      const pulled = { DATABASE_URL: WRITABLE_SENTINEL };
      const { merged } = overlayDeployEnv(pulled, mirror);

      expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
      expect(statusOf(pulled, mirror)).toBe("not-mirrored");
    },
  );

  it.each([
    ["both empty", { DATABASE_URL: "" }, { DATABASE_URL: "" }],
    ["both missing", {}, {}],
    ["pulled empty, mirror missing", { DATABASE_URL: "" }, {}],
  ])("is unset when %s", (_label, pulled, mirror) => {
    expect(statusOf(pulled, mirror)).toBe("unset");
    expect(overlayDeployEnv(pulled, mirror).merged.DATABASE_URL ?? "").toBe("");
  });

  it("reports one entry per overlay name, in list order, and nothing else", () => {
    const { report } = overlayDeployEnv({}, {});

    expect(report.map((entry) => entry.name)).toEqual([...OVERLAY_NAMES]);
    report.forEach((entry) => expect(Object.keys(entry).sort()).toEqual(["name", "status"]));
  });

  it("never touches a name outside OVERLAY_NAMES, even when the mirror carries one", () => {
    const pulled = { R2_BUCKET: "", SENTRY_DSN: "", APP_BASE_URL: "https://lombakita.com" };
    const mirror = { R2_BUCKET: "from-mirror", SENTRY_DSN: "from-mirror", APP_BASE_URL: "other" };
    const { merged } = overlayDeployEnv(pulled, mirror);

    expect(merged.R2_BUCKET).toBe("");
    expect(merged.SENTRY_DSN).toBe("");
    expect(merged.APP_BASE_URL).toBe("https://lombakita.com");
  });

  it("does not mutate its inputs", () => {
    const pulled = { DATABASE_URL: "" };
    const mirror = { DATABASE_URL: WRITABLE_SENTINEL };

    overlayDeployEnv(pulled, mirror);

    expect(pulled).toEqual({ DATABASE_URL: "" });
    expect(mirror).toEqual({ DATABASE_URL: WRITABLE_SENTINEL });
  });
});

describe("unwritable mirror values", () => {
  it.each([
    ["a dollar sign", "ab$cd"],
    ["a double quote", 'ab"cd'],
    ["a single quote", "ab'cd"],
    ["a backtick", "ab`cd"],
    ["a backslash", "ab\\cd"],
    ["a space", "ab cd"],
    ["a trailing space", "abcd "],
    ["a newline", "ab\ncd"],
    ["a tab", "ab\tcd"],
    ["a non-ASCII character", "abécd"],
  ])("refuses a mirror value containing %s", (_label, value) => {
    expect(isWritableMirrorValue(value)).toBe(false);
    expect(statusOf({ DATABASE_URL: "" }, { DATABASE_URL: value })).toBe("unwritable");
  });

  it.each([
    ["pulled empty", { DATABASE_URL: "" }],
    ["pulled equal to it", { DATABASE_URL: "ab$cd" }],
    ["pulled different", { DATABASE_URL: WRITABLE_SENTINEL }],
  ])("is unwritable whatever the pulled value is (%s), and never merged", (_label, pulled) => {
    const { merged } = overlayDeployEnv(pulled, { DATABASE_URL: "ab$cd" });

    expect(statusOf(pulled, { DATABASE_URL: "ab$cd" })).toBe("unwritable");
    expect(merged.DATABASE_URL).toBe(pulled.DATABASE_URL);
  });

  it("accepts every character the owner ruled writable", () => {
    expect(isWritableMirrorValue(WRITABLE_SENTINEL)).toBe(true);
    expect(isWritableMirrorValue("=#%@?&+/")).toBe(true);
  });
});

describe("blocking statuses", () => {
  it.each<[OverlayStatus, boolean]>([
    ["filled-from-github", false],
    ["equal", false],
    ["not-mirrored", false],
    ["unset", false],
    ["drift", true],
    ["unwritable", true],
  ])("%s blocks the run: %s", (status, blocks) => {
    expect(hasBlockingOverlayStatus([{ name: "DATABASE_URL", status }])).toBe(blocks);
  });
});

describe("the report never carries a value", () => {
  const valueBearingCases = [
    ["filled", { DATABASE_URL: "" }, { DATABASE_URL: WRITABLE_SENTINEL }],
    ["equal", { DATABASE_URL: WRITABLE_SENTINEL }, { DATABASE_URL: WRITABLE_SENTINEL }],
    ["drift", { DATABASE_URL: WRITABLE_SENTINEL }, { DATABASE_URL: OTHER_WRITABLE_SENTINEL }],
    ["not-mirrored", { DATABASE_URL: WRITABLE_SENTINEL }, {}],
    ["unwritable", { DATABASE_URL: WRITABLE_SENTINEL }, { DATABASE_URL: 'a$b"c d ' }],
  ] as const;

  it.each(valueBearingCases)("%s", (_label, pulled, mirror) => {
    const serialized = JSON.stringify(overlayDeployEnv(pulled, mirror).report);

    for (const value of [WRITABLE_SENTINEL, OTHER_WRITABLE_SENTINEL, 'a$b"c d ']) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toMatch(/[=#$%@?&+]/);
  });
});

// Rule 32: presence is not enforcement. The overlay is only wired if the overlay step sits between
// the pull and layer 1 in BOTH jobs, so position is asserted, not just presence. Read as text, the
// same way ci-gates.test.ts reads ci.yml: a YAML parser is a dependency this repo does not have.
describe("deploy.yml wiring", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/deploy.yml"), "utf8");
  const previewStart = workflow.indexOf("\n  deploy-preview:");
  const productionStart = workflow.indexOf("\n  deploy-production:");
  const jobs = [
    {
      label: "deploy-preview",
      environment: "preview",
      text: workflow.slice(previewStart, productionStart),
    },
    {
      label: "deploy-production",
      environment: "production",
      text: workflow.slice(productionStart),
    },
  ];

  const indexOfCommand = (text: string, command: string): number => {
    // `.*` because the preview deploy step wraps the command: run: echo "url=$(vercel deploy …)".
    const match = new RegExp(`^\\s*run: .*${command}`, "m").exec(text);

    return match ? match.index : -1;
  };

  it("finds both jobs", () => {
    expect(previewStart).toBeGreaterThan(-1);
    expect(productionStart).toBeGreaterThan(previewStart);
  });

  describe.each(jobs)("$label", ({ environment, text }) => {
    const order = [
      ["vercel pull", `vercel pull --yes --environment=${environment}`],
      ["npm ci", "npm ci"],
      ["overlay", "npm run deploy:overlay-env"],
      ["layer 1", "npm run verify:deploy-env"],
      ["layer 2", "npm run connectors:status:live"],
      ["schema gate", "npm run verify:schema-drift"],
      ["vercel build", "vercel build"],
      ["vercel deploy", "vercel deploy --prebuilt"],
    ] as const;

    it("runs the overlay after the pull and install, before layer 1, and every later step after it", () => {
      const positions = order.map(([, command]) => indexOfCommand(text, command));

      expect(positions.every((position) => position > -1)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it(`binds the job to the ${environment} environment`, () => {
      expect(text).toMatch(new RegExp(`^    environment: ${environment}$`, "m"));
    });

    it("maps each of the nine names exactly once, from the matching secret", () => {
      for (const name of OVERLAY_NAMES) {
        const line = `MIRROR_${name}: \${{ secrets.${name} }}`;

        expect(text.split(line).length - 1).toBe(1);
        expect(text.split(`secrets.${name} `).length - 1).toBe(1);
      }
    });

    it("exposes the secrets to no other step: nine MIRROR_ lines and no job-level exposure", () => {
      expect(text.match(/MIRROR_[A-Z0-9_]+:/g)).toHaveLength(OVERLAY_NAMES.length);
      expect(
        text.match(
          /secrets\.(DATABASE_URL|MIGRATION_DATABASE_URL|AUTH_SECRET|REDIS_URL|MEILISEARCH_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|RESEND_API_KEY|MFA_SECRET_ENCRYPTION_KEY)/g,
        ),
      ).toHaveLength(OVERLAY_NAMES.length);
    });

    it("never traces shell execution or echoes a mirror variable", () => {
      expect(text).not.toMatch(/set -x/);
      expect(text).not.toMatch(/echo[^\n]*MIRROR_/);
    });
  });

  it("the package.json script runs the overlay script", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["deploy:overlay-env"]).toBe(
      "node --import tsx src/server/scripts/overlay-deploy-env.ts",
    );
  });
});
