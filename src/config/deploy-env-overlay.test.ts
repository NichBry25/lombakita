// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERLAY_NAMES,
  PLAIN_REQUIRED_NAMES,
  SENSITIVE_PLACEHOLDER,
  findSensitivePlaceholdersOutsideOverlay,
  findSensitivePublicPlaceholders,
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

describe("the CLI 62 Sensitive placeholder", () => {
  const placeholderPulled = { DATABASE_URL: SENSITIVE_PLACEHOLDER };

  it("is exactly the bracketed string the CLI writes", () => {
    expect(SENSITIVE_PLACEHOLDER).toBe("[SENSITIVE]");
  });

  it("is filled from the mirror when one exists", () => {
    const mirror = { DATABASE_URL: WRITABLE_SENTINEL };
    const { merged } = overlayDeployEnv(placeholderPulled, mirror);

    expect(statusOf(placeholderPulled, mirror)).toBe("filled-from-github");
    expect(merged.DATABASE_URL).toBe(WRITABLE_SENTINEL);
  });

  it.each([
    ["empty", { DATABASE_URL: "" }],
    ["missing", {}],
  ])("is sensitive-unmirrored, and unchanged, when the mirror is %s", (_label, mirror) => {
    const { merged } = overlayDeployEnv(placeholderPulled, mirror);

    expect(statusOf(placeholderPulled, mirror)).toBe("sensitive-unmirrored");
    expect(merged.DATABASE_URL).toBe(SENSITIVE_PLACEHOLDER);
  });

  it("is unwritable, not filled, when the mirror cannot be written", () => {
    const mirror = { DATABASE_URL: "ab$cd" };

    expect(statusOf(placeholderPulled, mirror)).toBe("unwritable");
    expect(overlayDeployEnv(placeholderPulled, mirror).merged.DATABASE_URL).toBe(
      SENSITIVE_PLACEHOLDER,
    );
  });

  it("never reports drift: a placeholder is not a value to compare", () => {
    const mirror = { DATABASE_URL: OTHER_WRITABLE_SENTINEL };

    expect(statusOf(placeholderPulled, mirror)).not.toBe("drift");
  });

  // The legacy CLI 56 shape must keep behaving exactly as before.
  it("leaves the empty-pull behaviour of CLI 56 unchanged", () => {
    expect(statusOf({ DATABASE_URL: "" }, { DATABASE_URL: WRITABLE_SENTINEL })).toBe(
      "filled-from-github",
    );
    expect(statusOf({ DATABASE_URL: "" }, {})).toBe("unset");
    expect(statusOf({}, {})).toBe("unset");
  });

  // Matched as the WHOLE value, case-sensitive: anything else is an ordinary value, and an ordinary
  // value with no mirror is not-mirrored, with a different mirror is drift.
  it.each([
    ["lower case", "[sensitive]"],
    ["a leading space", " [SENSITIVE]"],
    ["a trailing space", "[SENSITIVE] "],
    ["a prefix", "x[SENSITIVE]"],
    ["a suffix", "[SENSITIVE]x"],
    ["no closing bracket", "[SENSITIVE"],
    ["no brackets", "SENSITIVE"],
  ])("does not treat %s as the placeholder", (_label, value) => {
    expect(statusOf({ DATABASE_URL: value }, {})).toBe("not-mirrored");
    expect(statusOf({ DATABASE_URL: value }, { DATABASE_URL: WRITABLE_SENTINEL })).toBe("drift");
  });

  it("is found by name on keys outside the nine, and only there", () => {
    const env = {
      GOOGLE_CLIENT_SECRET: SENSITIVE_PLACEHOLDER,
      SENTRY_DSN: "[sensitive]",
      R2_BUCKET: "lombakita-prod",
      DATABASE_URL: SENSITIVE_PLACEHOLDER,
      AUTH_SECRET: SENSITIVE_PLACEHOLDER,
    };

    expect(findSensitivePlaceholdersOutsideOverlay(env)).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });

  it("reports no values for any placeholder case", () => {
    const serialized = JSON.stringify(
      overlayDeployEnv(placeholderPulled, { DATABASE_URL: WRITABLE_SENTINEL }).report,
    );

    expect(serialized).not.toContain(WRITABLE_SENTINEL);
  });
});

describe("a mirror value equal to the placeholder", () => {
  it("is not a writable value", () => {
    expect(isWritableMirrorValue(SENSITIVE_PLACEHOLDER)).toBe(false);
  });

  it.each([
    ["pulled empty", { DATABASE_URL: "" }],
    ["pulled missing", {}],
    ["pulled the placeholder", { DATABASE_URL: SENSITIVE_PLACEHOLDER }],
    ["pulled a plain value", { DATABASE_URL: WRITABLE_SENTINEL }],
  ])("is unwritable, and never merged, when %s", (_label, pulled) => {
    const mirror = { DATABASE_URL: SENSITIVE_PLACEHOLDER };
    const { merged } = overlayDeployEnv(pulled, mirror);

    expect(statusOf(pulled, mirror)).toBe("unwritable");
    expect(merged.DATABASE_URL).toBe((pulled as Record<string, string>).DATABASE_URL);
  });
});

describe("a NEXT_PUBLIC_ variable holding the placeholder", () => {
  const pulled = {
    NEXT_PUBLIC_APP_NAME: SENSITIVE_PLACEHOLDER,
    NEXT_PUBLIC_SENTRY_DSN: SENSITIVE_PLACEHOLDER,
    NEXT_PUBLIC_APP_URL: "https://lombakita.com",
    GOOGLE_CLIENT_SECRET: SENSITIVE_PLACEHOLDER,
    SENTRY_DSN: SENSITIVE_PLACEHOLDER,
  };

  it("is reported sensitive-public-placeholder, by name, after the nine", () => {
    const { report } = overlayDeployEnv(pulled, {});
    const extra = report.slice(OVERLAY_NAMES.length);

    expect(extra).toEqual([
      { name: "NEXT_PUBLIC_APP_NAME", status: "sensitive-public-placeholder" },
      { name: "NEXT_PUBLIC_SENTRY_DSN", status: "sensitive-public-placeholder" },
    ]);
  });

  it("blocks the run", () => {
    expect(hasBlockingOverlayStatus(overlayDeployEnv(pulled, {}).report)).toBe(true);
  });

  it("is found by findSensitivePublicPlaceholders and not by the warn-only finder", () => {
    expect(findSensitivePublicPlaceholders(pulled)).toEqual([
      "NEXT_PUBLIC_APP_NAME",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]);
    expect(findSensitivePlaceholdersOutsideOverlay(pulled)).toEqual([
      "GOOGLE_CLIENT_SECRET",
      "SENTRY_DSN",
    ]);
  });

  it("does not block when no NEXT_PUBLIC_ variable holds the placeholder", () => {
    const { report } = overlayDeployEnv(
      { NEXT_PUBLIC_APP_URL: "https://lombakita.com", GOOGLE_CLIENT_SECRET: SENSITIVE_PLACEHOLDER },
      {},
    );

    expect(report.map((entry) => entry.name)).toEqual([...OVERLAY_NAMES]);
  });

  it("matches the whole value only", () => {
    expect(findSensitivePublicPlaceholders({ NEXT_PUBLIC_APP_NAME: "[sensitive]" })).toEqual([]);
    expect(findSensitivePublicPlaceholders({ NEXT_PUBLIC_APP_NAME: " [SENSITIVE]" })).toEqual([]);
    expect(findSensitivePublicPlaceholders({ APP_NEXT_PUBLIC_X: SENSITIVE_PLACEHOLDER })).toEqual(
      [],
    );
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
    ["sensitive-unmirrored", true],
    ["sensitive-public-placeholder", true],
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
      ["install vercel CLI", "npm install --global vercel@"],
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

    // Sensitive-variable behaviour changed between CLI 56 (empty) and 62 (a placeholder), so an
    // unpinned install lets the next release change what the gate reads without a commit.
    it("installs an exact vercel semver, never a tag or a range", () => {
      expect(text).toMatch(/^\s*run: npm install --global vercel@\d+\.\d+\.\d+$/m);
      expect(text).not.toMatch(/vercel@(latest|next|canary|beta)\b/);
      expect(text).not.toMatch(/vercel@[\^~>]/);
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

  // Token-level, not a regex over the whole line: `@vercel/build-utils` and `vercel pull` are not
  // installs of the CLI, while `npm i -g vercel`, `npx vercel` and `vercel@^62` all are, or run,
  // an unpinned one.
  const INSTALLER_OR_RUNNER =
    /\b(npm\s+(install|i|add|exec)|npx|pnpm\s+(add|dlx|exec)|yarn\s+(global\s+add|dlx)|bunx?)\b/;
  const EXACT_VERCEL = /^vercel@\d+\.\d+\.\d+$/;

  const findUnpinnedVercelUses = (workflowText: string): string[] =>
    workflowText
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => INSTALLER_OR_RUNNER.test(line))
      .filter((line) =>
        line
          .split(/\s+/)
          .map((token) => token.replace(/^["']|["']$/g, ""))
          .some(
            (token) =>
              (token === "vercel" || token.startsWith("vercel@")) && !EXACT_VERCEL.test(token),
          ),
      );

  describe("the CLI pin across the whole workflow", () => {
    it("pins the SAME exact version in both jobs", () => {
      const versions = jobs.map(({ text }) =>
        [...text.matchAll(/^\s*run: npm install --global vercel@(\d+\.\d+\.\d+)$/gm)].map(
          (match) => match[1],
        ),
      );

      expect(versions.every((found) => found.length === 1)).toBe(true);
      expect(new Set(versions.flat()).size).toBe(1);
    });

    it("has no step that installs or runs vercel without an exact version", () => {
      expect(findUnpinnedVercelUses(workflow)).toEqual([]);
    });

    // Rule 32: the detector above is only evidence if it is red for the forms it claims to catch.
    it.each([
      "run: npm i -g vercel",
      "run: npm install --global vercel",
      "run: npm install --global vercel@latest",
      "run: npm install --global vercel@^62.2.0",
      "run: npm install --global vercel@62",
      "run: npx vercel pull --yes",
      "run: npx --yes vercel@latest build",
      "run: pnpm dlx vercel deploy",
      "run: npm exec vercel -- build",
    ])("flags %s", (line) => {
      expect(findUnpinnedVercelUses(line)).toEqual([line]);
    });

    it.each([
      "run: npm install --global vercel@62.2.0",
      "run: npm install --global @railway/cli",
      "run: vercel pull --yes --environment=preview",
      "run: npm ci",
      "# run: npm i -g vercel",
    ])("does not flag %s", (line) => {
      expect(findUnpinnedVercelUses(line)).toEqual([]);
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
