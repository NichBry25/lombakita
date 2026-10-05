// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseWithDotenv } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OVERLAY_NAMES,
  SENSITIVE_PLACEHOLDER,
  type OverlayName,
} from "@/config/deploy-env-overlay";
import {
  DuplicateOverlayKeyError,
  OverlayVerificationError,
  overlayEnvFileText,
} from "@/server/scripts/overlay-deploy-env";

// Every value is shape-valid for its gate rule AND made only of characters the writer may emit, so
// the same fixtures drive both the round-trip tests and the real layer-1 run. The `=#%@?&+/`
// characters sit in the parts of each value the shape rules do not constrain.
const MIRROR_VALUES: Record<OverlayName, string> = {
  DATABASE_URL: "postgresql://user:pass@ep-cool-1.neon.tech/lombakita_staging?a=b&c=d+e%2F#f=1",
  MIGRATION_DATABASE_URL: "postgresql://migrate:pass@ep-cool-1.neon.tech/lombakita_staging?x=y+z",
  AUTH_SECRET: `${"x".repeat(40)}=#%@?&+/`,
  REDIS_URL: "redis://default:secret@caboose.proxy.rlwy.net:29765/0?a=b&c=d+e%2F#f=1",
  MEILISEARCH_API_KEY: `${"b".repeat(40)}=#%@?&+/`,
  R2_ACCESS_KEY_ID: "c".repeat(32),
  R2_SECRET_ACCESS_KEY: "d".repeat(64),
  RESEND_API_KEY: "re_abcdef123456",
  MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const PLAIN_LINES = [
  "# Created by Vercel CLI",
  `R2_ENDPOINT="https://${"a".repeat(32)}.r2.cloudflarestorage.com"`,
  'R2_BUCKET="lombakita-staging"',
  'MEILISEARCH_HOST="https://meilisearch-staging.up.railway.app"',
  'AUTH_EMAIL_FROM="noreply@seed.lombakita.local"',
  'SENTRY_DSN="https://key@o1.ingest.sentry.io/2"',
  "",
  'UNRELATED_NOTE="a b#c"',
];

const lineFor = (name: string, value: string) => `${name}="${value}"`;

const pulledTextWith = (values: Partial<Record<OverlayName, string>>): string =>
  [...PLAIN_LINES, ...OVERLAY_NAMES.map((name) => lineFor(name, values[name] ?? ""))].join("\n") +
  "\n";

const sensitivePulledText = () => pulledTextWith({});
const plainPulledText = () => pulledTextWith(MIRROR_VALUES);
const placeholderPulledText = () =>
  pulledTextWith(
    Object.fromEntries(OVERLAY_NAMES.map((name) => [name, SENSITIVE_PLACEHOLDER])) as Record<
      OverlayName,
      string
    >,
  );

const mirrorFrom = (values: Partial<Record<OverlayName, string>>) => values;

const unchangedLines = (text: string) =>
  text.split("\n").filter((line) => !OVERLAY_NAMES.some((name) => line.startsWith(`${name}=`)));

describe("overlayEnvFileText", () => {
  it("replaces an empty overlay line in place, quoted with single quotes", () => {
    const { text } = overlayEnvFileText(sensitivePulledText(), MIRROR_VALUES);

    expect(text).toContain(`DATABASE_URL='${MIRROR_VALUES.DATABASE_URL}'\n`);
    expect(text).not.toContain('DATABASE_URL=""');
  });

  it("preserves every non-overlay line byte for byte, in order", () => {
    const original = sensitivePulledText();
    const { text } = overlayEnvFileText(original, MIRROR_VALUES);

    expect(unchangedLines(text)).toEqual(unchangedLines(original));
  });

  it("appends a key the pulled file does not contain", () => {
    const original = PLAIN_LINES.join("\n") + "\n";
    const { text } = overlayEnvFileText(original, { REDIS_URL: MIRROR_VALUES.REDIS_URL });

    expect(text).toBe(`${original}REDIS_URL='${MIRROR_VALUES.REDIS_URL}'\n`);
  });

  it("adds a line break before appending when the file lacks a final one", () => {
    const { text } = overlayEnvFileText("A=1", { REDIS_URL: "r" });

    expect(text).toBe("A=1\nREDIS_URL='r'\n");
  });

  it("keeps CRLF line endings on the lines it leaves alone and on the one it replaces", () => {
    const original = 'A=1\r\nREDIS_URL=""\r\nB=2\r\n';
    const { text } = overlayEnvFileText(original, { REDIS_URL: "r" });

    expect(text).toBe("A=1\r\nREDIS_URL='r'\r\nB=2\r\n");
  });

  it("returns the file untouched when every overlay name is equal, unset or not-mirrored", () => {
    const original = plainPulledText();

    expect(overlayEnvFileText(original, {}).text).toBe(original);
    expect(overlayEnvFileText(original, MIRROR_VALUES).text).toBe(original);
  });

  it("returns the file untouched when the run is blocked by drift", () => {
    const original = sensitivePulledText().replace(/^DATABASE_URL=""$/m, 'DATABASE_URL="old"');
    const { text, report } = overlayEnvFileText(original, MIRROR_VALUES);

    expect(report.find((entry) => entry.name === "DATABASE_URL")?.status).toBe("drift");
    expect(text).toBe(original);
  });

  it("returns the file untouched when the run is blocked by an unwritable value", () => {
    const original = sensitivePulledText();
    const { text, report } = overlayEnvFileText(original, { ...MIRROR_VALUES, REDIS_URL: "a$b" });

    expect(report.find((entry) => entry.name === "REDIS_URL")?.status).toBe("unwritable");
    expect(text).toBe(original);
  });

  it("refuses a pulled file that holds an overlay key twice, even one it would not fill", () => {
    const original = `${plainPulledText()}DATABASE_URL="again"\n`;

    expect(() => overlayEnvFileText(original, {})).toThrow(DuplicateOverlayKeyError);
  });

  // Rule 32, removal direction: without the re-parse, this rewrite would silently corrupt NOTE.
  it("refuses to write when the rewrite would change a key outside the nine", () => {
    const original = 'NOTE="first line\nREDIS_URL=\nlast line"\nA=1\n';

    expect(() => overlayEnvFileText(original, { REDIS_URL: "r" })).toThrow(
      OverlayVerificationError,
    );
  });
});

describe("overlayEnvFileText with the CLI 62 placeholder", () => {
  it("fills every placeholder line in place and re-parses to the mirror in both parsers", () => {
    const original = placeholderPulledText();
    const { text, report } = overlayEnvFileText(original, MIRROR_VALUES);

    expect(report.map((entry) => entry.status)).toEqual(
      OVERLAY_NAMES.map(() => "filled-from-github"),
    );
    expect(unchangedLines(text)).toEqual(unchangedLines(original));
    expect(text).not.toContain(SENSITIVE_PLACEHOLDER);
    expect(parseWithDotenv(text)).toEqual(parseEnv(text));
    OVERLAY_NAMES.forEach((name) => expect(parseEnv(text)[name]).toBe(MIRROR_VALUES[name]));
  });

  it("blocks, and leaves the file untouched, when a placeholder name has no mirror", () => {
    const original = placeholderPulledText();
    const { text, report } = overlayEnvFileText(original, {
      ...MIRROR_VALUES,
      REDIS_URL: undefined,
    });

    expect(report.find((entry) => entry.name === "REDIS_URL")?.status).toBe("sensitive-unmirrored");
    expect(text).toBe(original);
  });

  it("names a non-overlay key holding the placeholder and does not modify it", () => {
    const original = `${placeholderPulledText()}GOOGLE_CLIENT_SECRET="${SENSITIVE_PLACEHOLDER}"\n`;
    const { text, placeholdersOutsideOverlay } = overlayEnvFileText(original, MIRROR_VALUES);

    expect(placeholdersOutsideOverlay).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(text).toContain(`GOOGLE_CLIENT_SECRET="${SENSITIVE_PLACEHOLDER}"\n`);
  });
});

describe("round trip", () => {
  it("reads back identically in Node's parser and dotenv, and equals the merged map", () => {
    const { text } = overlayEnvFileText(sensitivePulledText(), MIRROR_VALUES);

    const withNode = parseEnv(text);
    const withDotenv = parseWithDotenv(text);

    expect(withDotenv).toEqual(withNode);
    for (const name of OVERLAY_NAMES) {
      expect(withNode[name]).toBe(MIRROR_VALUES[name]);
    }
  });

  it("leaves every other key's parsed value as it was, in both parsers", () => {
    const original = sensitivePulledText();
    const { text } = overlayEnvFileText(original, MIRROR_VALUES);
    const nine = new Set<string>(OVERLAY_NAMES);
    const outsideNine = (env: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(env).filter(([key]) => !nine.has(key)));

    expect(outsideNine(parseEnv(text))).toEqual(outsideNine(parseEnv(original)));
    expect(outsideNine(parseWithDotenv(text))).toEqual(outsideNine(parseWithDotenv(original)));
  });
});

describe("the script, run as `npm run deploy:overlay-env` runs it", { timeout: 60_000 }, () => {
  const scriptPath = resolve(process.cwd(), "src/server/scripts/overlay-deploy-env.ts");
  const verifyPath = resolve(process.cwd(), "src/server/scripts/verify-deploy-env.ts");
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "overlay-deploy-env-"));
    filePath = join(directory, "pulled.local");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const cleanEnvironment = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base = { ...process.env };

    for (const name of OVERLAY_NAMES) {
      delete base[name];
      delete base[`MIRROR_${name}`];
    }
    delete base.FORCE_COLOR;

    return { ...base, ...extra };
  };

  const mirrorEnvironment = (values: Partial<Record<OverlayName, string>>) =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [`MIRROR_${name}`, value]));

  const runOverlay = (values: Partial<Record<OverlayName, string>>, args: string[] = []) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--environment=preview", `--env-path=${filePath}`, ...args],
      {
        cwd: process.cwd(),
        env: cleanEnvironment(mirrorEnvironment(values)),
        encoding: "utf8",
      },
    );

  const runLayerOne = () =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", verifyPath, "--environment=preview", `--env-path=${filePath}`],
      { cwd: process.cwd(), env: cleanEnvironment(), encoding: "utf8" },
    );

  const outputOf = (result: ReturnType<typeof runOverlay>) => `${result.stdout}${result.stderr}`;

  const ALLOWED_LINE =
    /^(overlay: environment=(preview|production) file=\S+|overlay: [A-Z0-9_]+ [a-z-]+|::warning::overlay: [A-Z0-9_]+ is not mirrored.*|::warning::overlay: [A-Z0-9_]+ sensitive-placeholder-outside-overlay|::error::overlay: [A-Z0-9_]+ is Sensitive on Vercel and has no GitHub environment secret|Deploy env overlay failed: [A-Za-z]+ \(\S+\)|)$/;

  const expectNoValueInOutput = (result: ReturnType<typeof runOverlay>, values: string[]) => {
    const output = outputOf(result);

    for (const value of values) {
      expect(output).not.toContain(value);
    }
    output.split("\n").forEach((line) => expect(line).toMatch(ALLOWED_LINE));
  };

  const statusLines = (result: ReturnType<typeof runOverlay>) =>
    result.stdout.split("\n").filter((line) => /^overlay: [A-Z0-9_]+ [a-z-]+$/.test(line));

  const allValues = Object.values(MIRROR_VALUES);

  describe("Sensitive on Vercel under CLI 62: the pulled value is the placeholder", () => {
    it("all nine placeholder and none mirrored: exits 1, nine sensitive-unmirrored names, file untouched", () => {
      writeFileSync(filePath, placeholderPulledText());

      const overlay = runOverlay({});

      expect(overlay.status).toBe(1);
      expect(statusLines(overlay)).toEqual(
        OVERLAY_NAMES.map((name) => `overlay: ${name} sensitive-unmirrored`),
      );
      expect(overlay.stdout.match(/^::error::/gm)).toHaveLength(OVERLAY_NAMES.length);
      expect(readFileSync(filePath, "utf8")).toBe(placeholderPulledText());
      expectNoValueInOutput(overlay, allValues);
    });

    it("all nine placeholder and all mirrored: nine filled-from-github, and layer 1 then passes", () => {
      writeFileSync(filePath, placeholderPulledText());

      const overlay = runOverlay(mirrorFrom(MIRROR_VALUES));

      expect(overlay.status).toBe(0);
      expect(statusLines(overlay)).toEqual(
        OVERLAY_NAMES.map((name) => `overlay: ${name} filled-from-github`),
      );
      expectNoValueInOutput(overlay, allValues);

      const rewritten = readFileSync(filePath, "utf8");
      expect(parseEnv(rewritten)).toEqual(parseWithDotenv(rewritten));
      OVERLAY_NAMES.forEach((name) => expect(parseEnv(rewritten)[name]).toBe(MIRROR_VALUES[name]));
      expect(unchangedLines(rewritten)).toEqual(unchangedLines(placeholderPulledText()));

      const layerOne = runLayerOne();
      expect(layerOne.status).toBe(0);
      expect(layerOne.stdout).not.toContain("FAILED");
    });

    it("eight mirrored and one not: exits 1 naming only that variable, file untouched", () => {
      writeFileSync(filePath, placeholderPulledText());
      const mirrored: Partial<Record<OverlayName, string>> = {
        ...MIRROR_VALUES,
        REDIS_URL: undefined,
      };

      const overlay = runOverlay(mirrorFrom(mirrored));

      expect(overlay.status).toBe(1);
      expect(statusLines(overlay).filter((line) => line.endsWith("sensitive-unmirrored"))).toEqual([
        "overlay: REDIS_URL sensitive-unmirrored",
      ]);
      expect(readFileSync(filePath, "utf8")).toBe(placeholderPulledText());
      expectNoValueInOutput(overlay, allValues);
    });

    it("a non-overlay key holding the placeholder is warned about by name and left alone", () => {
      const original = `${placeholderPulledText()}GOOGLE_CLIENT_SECRET="${SENSITIVE_PLACEHOLDER}"\n`;
      writeFileSync(filePath, original);

      const overlay = runOverlay(mirrorFrom(MIRROR_VALUES));

      expect(overlay.status).toBe(0);
      expect(overlay.stdout).toContain(
        "::warning::overlay: GOOGLE_CLIENT_SECRET sensitive-placeholder-outside-overlay",
      );
      expect(readFileSync(filePath, "utf8")).toContain(
        `GOOGLE_CLIENT_SECRET="${SENSITIVE_PLACEHOLDER}"\n`,
      );
      expectNoValueInOutput(overlay, allValues);
    });
  });

  describe("Sensitive on Vercel and mirrored in GitHub", () => {
    it("fills all nine, exits 0, and layer 1 then passes against the rewritten file", () => {
      writeFileSync(filePath, sensitivePulledText());

      const overlay = runOverlay(mirrorFrom(MIRROR_VALUES));

      expect(overlay.status).toBe(0);
      expect(statusLines(overlay)).toEqual(
        OVERLAY_NAMES.map((name) => `overlay: ${name} filled-from-github`),
      );
      expectNoValueInOutput(overlay, allValues);

      const rewritten = readFileSync(filePath, "utf8");
      expect(parseEnv(rewritten)).toEqual(parseWithDotenv(rewritten));
      OVERLAY_NAMES.forEach((name) => expect(parseEnv(rewritten)[name]).toBe(MIRROR_VALUES[name]));
      expect(unchangedLines(rewritten)).toEqual(unchangedLines(sensitivePulledText()));

      const layerOne = runLayerOne();
      expect(layerOne.status).toBe(0);
      expect(layerOne.stdout).toContain("RESULT:");
      expect(layerOne.stdout).not.toContain("FAILED");
    });
  });

  describe("Sensitive on Vercel but NOT mirrored", () => {
    it("leaves the file alone, and layer 1 then fails naming each variable", () => {
      writeFileSync(filePath, sensitivePulledText());

      const overlay = runOverlay({});

      expect(overlay.status).toBe(0);
      expect(statusLines(overlay)).toEqual(OVERLAY_NAMES.map((name) => `overlay: ${name} unset`));
      expect(readFileSync(filePath, "utf8")).toBe(sensitivePulledText());

      const layerOne = runLayerOne();
      expect(layerOne.status).toBe(1);
      OVERLAY_NAMES.forEach((name) => expect(layerOne.stdout).toContain(name));
    });
  });

  describe("the transition state: plain on Vercel, nothing mirrored yet", () => {
    it("passes with a not-mirrored warning per name and does not rewrite the file", () => {
      writeFileSync(filePath, plainPulledText());

      const overlay = runOverlay({});

      expect(overlay.status).toBe(0);
      expect(statusLines(overlay)).toEqual(
        OVERLAY_NAMES.map((name) => `overlay: ${name} not-mirrored`),
      );
      expect(overlay.stdout.match(/^::warning::/gm)).toHaveLength(OVERLAY_NAMES.length);
      expect(readFileSync(filePath, "utf8")).toBe(plainPulledText());
      expectNoValueInOutput(overlay, allValues);
    });
  });

  describe("plain on Vercel and mirrored with a different value", () => {
    it("fails with drift naming only the variable, and does not touch the file", () => {
      writeFileSync(filePath, plainPulledText());
      const drifted = { ...MIRROR_VALUES, AUTH_SECRET: `${"y".repeat(40)}=#%@?&+/` };

      const overlay = runOverlay(drifted);

      expect(overlay.status).toBe(1);
      expect(statusLines(overlay)).toContain("overlay: AUTH_SECRET drift");
      expect(readFileSync(filePath, "utf8")).toBe(plainPulledText());
      expectNoValueInOutput(overlay, [...allValues, drifted.AUTH_SECRET]);
    });
  });

  describe("a mirror value the writer cannot emit", () => {
    it.each([
      ["a dollar sign", "bad$value"],
      ["a double quote", 'bad"value'],
      ["a single quote", "bad'value"],
      ["a backtick", "bad`value"],
      ["a backslash", "bad\\value"],
      ["a space", "bad value"],
      ["a newline", "bad\nvalue"],
    ])("is refused as unwritable when it has %s, with the file untouched", (_label, value) => {
      writeFileSync(filePath, sensitivePulledText());

      const overlay = runOverlay({ ...MIRROR_VALUES, REDIS_URL: value });

      expect(overlay.status).toBe(1);
      expect(statusLines(overlay)).toContain("overlay: REDIS_URL unwritable");
      expect(readFileSync(filePath, "utf8")).toBe(sensitivePulledText());
      expectNoValueInOutput(overlay, [...allValues, value]);
    });
  });

  describe("failures print only the error class and the file path", () => {
    it("on a duplicated key", () => {
      const original = `${plainPulledText()}REDIS_URL="again"\n`;
      writeFileSync(filePath, original);

      const overlay = runOverlay(mirrorFrom(MIRROR_VALUES));

      expect(overlay.status).toBe(1);
      expect(overlay.stderr.trim()).toBe(
        `Deploy env overlay failed: DuplicateOverlayKeyError (${filePath})`,
      );
      expect(readFileSync(filePath, "utf8")).toBe(original);
      expectNoValueInOutput(overlay, allValues);
    });

    it("when the rewrite would change another key", () => {
      const original = 'NOTE="first line\nREDIS_URL=\nlast line"\n';
      writeFileSync(filePath, original);

      const overlay = runOverlay({ REDIS_URL: MIRROR_VALUES.REDIS_URL });

      expect(overlay.status).toBe(1);
      expect(overlay.stderr.trim()).toBe(
        `Deploy env overlay failed: OverlayVerificationError (${filePath})`,
      );
      expect(readFileSync(filePath, "utf8")).toBe(original);
      expectNoValueInOutput(overlay, allValues);
    });

    it("when the pulled file does not exist", () => {
      const overlay = runOverlay(mirrorFrom(MIRROR_VALUES));

      expect(overlay.status).toBe(1);
      expect(overlay.stderr.trim()).toBe(
        `Deploy env overlay failed: PulledEnvFileMissingError (${filePath})`,
      );
      expectNoValueInOutput(overlay, allValues);
    });
  });
});
