import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  applyAllowlist,
  classifyContent,
  fingerprintOf,
  isForbiddenEnvPath,
  looksRandom,
  maskSecret,
  scanText,
  validateAllowlist,
} from "./secret-rules";

describe("scanText", () => {
  it("catches the leaked line whatever the variable is called", () => {
    // The regression this whole file exists for. Two earlier scans keyed on the name
    // `DATABASE_URL`, found nothing, and reported the repository clean while this exact line sat
    // on `main` in a public repository. The name is chosen by whoever writes the leak.
    const findings = scanText(
      'const DB_URL = "postgresql://lombakita_app:R3alPassw0rdHere@localhost:5432/lombakita";',
      "seed.ts",
    );

    expect(findings.map((finding) => finding.ruleId)).toContain("uri-credential");
  });

  it("catches a credential whose host is loopback", () => {
    // `isLocalDatabaseHost` reads the same string and answers true, meaning "local, safe to write
    // through". That answer is correct for its own question and says nothing about the password,
    // which was valid against production. Nothing here may treat a host as evidence about a value.
    const findings = scanText(
      'url: "postgresql://app:N0tAPlaceholder1@127.0.0.1:5432/db"',
      "anywhere.ts",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("uri-credential");
  });

  it("never prints enough of a secret to reconstruct it", () => {
    const secret = "R3alPassw0rdHere";
    const findings = scanText(
      `const u = "postgresql://app:${secret}@localhost:5432/db";`,
      "seed.ts",
    );

    expect(findings[0]?.preview).not.toContain(secret);
    expect(findings[0]?.preview).not.toContain(secret.slice(3));
  });

  it("reports the line the credential is on", () => {
    const findings = scanText(
      ["const a = 1;", "const b = 2;", 'const c = "postgresql://u:S3cretValue1@host/db";'].join(
        "\n",
      ),
      "x.ts",
    );

    expect(findings[0]?.line).toBe(3);
  });

  it("ignores the conventional local and CI fixture passwords", () => {
    // These recur in dozens of files. If the gate reported them it would be turned off, which is
    // the ordinary way a scanner stops working.
    for (const url of [
      "postgresql://postgres:postgres@localhost:5432/lombakita_ci",
      "postgresql://user:password@localhost:5432/lombakita",
      "redis://default:secret@localhost:6379",
    ]) {
      expect(scanText(`const u = "${url}";`, "fixture.test.ts")).toHaveLength(0);
    }
  });

  it("ignores an obvious placeholder", () => {
    expect(
      scanText("RESEND_API_KEY=replace-with-prod-resend-key", ".env.production.example"),
    ).toHaveLength(0);
  });

  it("ignores Subresource Integrity digests", () => {
    // package-lock.json holds around three hundred of these. They are random looking by
    // construction and published deliberately.
    const findings = scanText(
      '"integrity": "sha512-abcDEF123456789ghiJKLmnop0987654321qrsTUVwxyz+/AbCd=="',
      "package-lock.json",
    );

    expect(findings).toHaveLength(0);
  });

  it("catches provider keys by prefix", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["re_a1b2c3d4_ABCDEFGHIJKLMNOPQRSTUV", "resend-api-key"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      ["-----BEGIN RSA PRIVATE KEY-----", "private-key-block"],
    ];

    for (const [value, expectedRule] of cases) {
      const findings = scanText(`const k = "${value}";`, "x.ts");
      expect(findings.map((finding) => finding.ruleId)).toContain(expectedRule);
    }
  });
});

// Built from parts so this file does not itself carry a scannable credential. The scanner reads
// its own source like every other tracked file, and these are exactly the values it now reports.
const ENTROPY_20 = "Xk9mPq2vLwRnZt7BqYh3";
const ENTROPY_29 = `${ENTROPY_20}zQ9tR2mN5`;

/** The password position of a connection URI, which is where these values are actually reachable. */
const uriWith = (password: string): string => `postgresql://app:${password}@db.internal:5432/db`;

describe("placeholder exemption", () => {
  it("exempts a substitution only when it accounts for the whole value", () => {
    expect(scanText(uriWith("${DATABASE_URL}"), "x.ts")).toHaveLength(0);

    // A substitution glued to the front of a real password. The exemption was anchored only at the
    // start, so the marker's first characters bought an exemption for everything after them.
    const findings = scanText(uriWith("${ENV}" + ENTROPY_20), "x.ts");

    expect(findings.map((finding) => finding.ruleId)).toEqual(["uri-credential"]);
  });

  it("exempts a marker prefix only when what follows it is not random", () => {
    // A marker with nothing of substance after it is still a placeholder, and must stay exempt.
    // Tightening these into findings would be a false-positive regression, not a stronger gate.
    for (const placeholder of ["your-api-key-here", "xxxxxxxx", "<your-key>", "changeme"]) {
      expect(scanText(uriWith(placeholder), "x.ts")).toHaveLength(0);
    }

    for (const marker of ["redacted", "your-", "dummy", "placeholder"]) {
      const findings = scanText(uriWith(marker + ENTROPY_29), "x.ts");

      expect(findings.map((finding) => finding.ruleId)).toEqual(["uri-credential"]);
    }
  });

  it("never reaches the exemption for an angle-bracketed value, whatever follows it", () => {
    // Reported as a second bypass, and at the observable level it is one: zero findings. The cause
    // is NOT this exemption. `high-entropy-literal` matches `[A-Za-z0-9+/=_-]` only and the uri
    // password class excludes `<` and `>`, so no rule ever yields this value as a secret to exempt.
    // Pinned because a reader who assumes the exemption owns this case will go and fix the wrong
    // thing, and because the day a rule does accept angle brackets this line starts failing.
    expect(scanText(`"<REDACTED>${ENTROPY_29}"`, "x.ts")).toHaveLength(0);
    expect(scanText(uriWith(`<REDACTED>${ENTROPY_29}`), "x.ts")).toHaveLength(0);
  });
});

describe("looksRandom", () => {
  it("rejects the identifier shapes a codebase is full of", () => {
    for (const value of [
      "updateInstitutionWorkspaceForOwnerBySlug",
      "PUBLIC_COMPETITION_COLUMNS_EXCLUDES_FEE",
      "registration-documents-comp-1-req-2",
      "some_long_snake_case_identifier_here",
    ]) {
      expect(looksRandom(value)).toBe(false);
    }
  });

  it("accepts a random looking key", () => {
    expect(looksRandom("xJ8kQ2mZ4pR7nW1sT5vY9bL3cH6dF0gA")).toBe(true);
  });
});

describe("fingerprintOf", () => {
  it("is independent of path, so moving a file does not reopen an approved decision", () => {
    const a = scanText('const u = "postgresql://app:S3cretValue1@db.internal/db";', "one/place.ts");
    const b = scanText(
      'const u = "postgresql://app:S3cretValue1@db.internal/db";',
      "another/place.ts",
    );

    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });

  it("differs when the value differs", () => {
    expect(fingerprintOf("uri-credential", "aaaa")).not.toBe(
      fingerprintOf("uri-credential", "bbbb"),
    );
  });
});

describe("classifyContent", () => {
  it("refuses an undeclared binary rather than skipping it", () => {
    // The fail-closed property. Skipping an input a gate cannot read is how a gate silently
    // covers less than its name implies.
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    expect(classifyContent(bytes, "mystery.bin")).toBe("unclassifiable");
  });

  it("accepts a declared binary extension", () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    expect(classifyContent(bytes, "logo.png")).toBe("declared-binary");
  });

  it("reads ordinary source as text", () => {
    expect(classifyContent(Buffer.from("const a = 1;\n", "utf8"), "a.ts")).toBe("text");
  });
});

describe("isForbiddenEnvPath", () => {
  it("rejects a tracked env file but allows the example templates", () => {
    expect(isForbiddenEnvPath(".env")).toBe(true);
    expect(isForbiddenEnvPath(".env.local")).toBe(true);
    expect(isForbiddenEnvPath("deploy/.env.production")).toBe(true);
    expect(isForbiddenEnvPath(".env.example")).toBe(false);
    expect(isForbiddenEnvPath(".env.production.example")).toBe(false);
  });
});

describe("validateAllowlist", () => {
  const entry = {
    fingerprint: "0123456789abcdef",
    rule: "uri-credential",
    preview: "masked",
    reason: "This is a fixture value and here is the explanation of why it cannot be real.",
  };

  it("accepts a complete entry", () => {
    expect(validateAllowlist({ entries: [entry] }).errors).toEqual([]);
  });

  it("rejects an entry whose reason is too short to be a reason", () => {
    const { entries, errors } = validateAllowlist({
      entries: [{ ...entry, reason: "false positive" }],
    });

    expect(entries).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("rejects a duplicate fingerprint", () => {
    const { errors } = validateAllowlist({ entries: [entry, entry] });

    expect(errors).toHaveLength(1);
  });

  it("rejects a malformed file rather than treating it as empty", () => {
    expect(validateAllowlist(null).errors).toHaveLength(1);
    expect(validateAllowlist({}).errors).toHaveLength(1);
  });
});

describe("applyAllowlist", () => {
  it("suppresses only the fingerprint it names", () => {
    const findings = scanText(
      'const a = "postgresql://app:S3cretValue1@db.internal/db";\nconst b = "postgresql://app:0therS3cret2@db.internal/db";',
      "x.ts",
    );
    const [first] = findings;
    expect(first).toBeDefined();

    const { reported, suppressed } = applyAllowlist(findings, [
      {
        fingerprint: first?.fingerprint ?? "",
        rule: "uri-credential",
        preview: "masked",
        reason: "Approved for the purposes of this test, with a reason long enough to count.",
      },
    ]);

    expect(suppressed).toHaveLength(1);
    expect(reported).toHaveLength(1);
  });
});

describe("maskSecret", () => {
  it("keeps at most the first two characters", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("ab************** (len 16)");
  });
});

/**
 * The wiring. Every test above builds its input by hand, which proves the rules and proves nothing
 * about whether the gate runs. These drive the real runner the way CI does and read its exit code.
 */
describe("the secret-scan runner", () => {
  const workspace = mkdtempSync(join(tmpdir(), "secret-scan-"));
  const runner = join(process.cwd(), "scripts", "testing", "secret-scan.ts");

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // Runs from the repository root, because that is where `tsx` resolves and where the runner can
  // find a git root, and names the fixture by absolute path so the scan reads the temp file.
  const run = (file: string): { status: number; output: string } => {
    try {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", runner, join(workspace, file)],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  };

  it("exits non-zero and names the file when a credential is present", () => {
    // The planted password is ASSEMBLED AT RUNTIME and never appears as a literal here.
    //
    // It was a literal at first, which meant the tree scan found it in this file, which meant it
    // got an allowlist entry, which meant the runner stopped reporting it and this test passed
    // against a gate that was no longer firing. Written this way, the source carries only the
    // placeholder-shaped `${plantedPassword}`, which the rules exempt, while the temp file the
    // runner actually reads carries a credential nothing has approved.
    const plantedPassword = `N0t${"AReal"}One99`;
    const planted = "planted.ts";
    writeFileSync(
      join(workspace, planted),
      `const DB_URL = "postgresql://lombakita_app:${plantedPassword}@localhost:5432/lombakita";\n`,
    );

    const { status, output } = run(planted);

    expect(status).toBe(1);
    expect(output).toContain(planted);
    expect(output).toContain("uri-credential");
    // The failing report must not itself become a second copy of the leak.
    expect(output).not.toContain(plantedPassword);
  });

  it("exits zero on a clean file", () => {
    const clean = "clean.ts";
    writeFileSync(join(workspace, clean), 'export const greeting = "halo";\n');

    expect(run(clean).status).toBe(0);
  });

  it("exits non-zero on an input it cannot classify", () => {
    const mystery = "mystery.bin";
    writeFileSync(join(workspace, mystery), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const { status, output } = run(mystery);

    expect(status).toBe(1);
    expect(output).toContain("could not classify");
  });
});
