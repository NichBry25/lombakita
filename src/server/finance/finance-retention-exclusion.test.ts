// @vitest-environment node
//
// A BUKTI TRANSFER IS NEVER PURGED, AT ANY AGE.
//
// It is financial evidence: the record of who sent money to whom for what. The competition ending
// is not a reason to destroy it, and "how old is it" is not a question that bears on whether it
// should still exist. This is the deliberate opposite of the registration documents the retention
// sweep does purge, whose whole retention argument is that holding someone's identity document
// after it stops being evidence is a liability.
//
// The risk this file exists to catch is a QUIET one. Nothing today deletes a proof — so a test that
// merely called the sweep and checked a proof survived would pass whether or not the exclusion was
// real, and would keep passing right up until someone adds a third sweep arm. What is asserted here
// instead is the SHAPE of the purge surface: which modules the retention job can reach, and that
// none of them names a finance table or the payment-proof object prefix.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const SRC_DIR = resolve(process.cwd(), "src");
const RETENTION_JOB = resolve(SRC_DIR, "server/async/jobs/retention-purge.ts");

/** Everything the retention job imports, transitively, within `src/`. */
const collectPurgeSurface = (entry: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(entry)) return seen;
  seen.add(entry);

  const source = readFileSync(entry, "utf8");
  const specifiers = [...source.matchAll(/from\s+"(@\/[^"]+)"/g)].map((match) => match[1]!);

  for (const specifier of specifiers) {
    const relative = specifier.replace(/^@\//, "");
    for (const candidate of [
      resolve(SRC_DIR, `${relative}.ts`),
      resolve(SRC_DIR, `${relative}/index.ts`),
    ]) {
      try {
        if (statSync(candidate).isFile()) {
          collectPurgeSurface(candidate, seen);
          break;
        }
      } catch {
        // Not a file on this candidate path; try the next shape.
      }
    }
  }

  return seen;
};

describe("retention sweep excludes financial evidence", () => {
  it("reaches no module that deletes from a finance table", () => {
    const surface = collectPurgeSurface(RETENTION_JOB);

    const offending: string[] = [];
    for (const file of surface) {
      const flattened = readFileSync(file, "utf8").replace(/\s*\n\s*/g, " ");
      if (
        /\.\s*delete\s*\(\s*finance[A-Za-z]*/.test(flattened) ||
        /\bdelete\s+from\s+finance_/i.test(flattened)
      ) {
        offending.push(file.replace(`${process.cwd()}/`, ""));
      }
    }

    expect(
      offending,
      "the retention sweep can reach a finance table — a bukti transfer is never purged",
    ).toEqual([]);
  });

  it("reaches no module that lists the payment-proof object prefix for deletion", () => {
    // Object storage is the other half. A proof row surviving while its FILE is swept is the same
    // loss: the evidence is the image, not the row that points at it.
    const surface = collectPurgeSurface(RETENTION_JOB);

    const offending: string[] = [];
    for (const file of surface) {
      const source = readFileSync(file, "utf8");
      if (source.includes("payment-proofs/") || source.includes("buildManualProofObjectPrefix")) {
        offending.push(file.replace(`${process.cwd()}/`, ""));
      }
    }

    expect(
      offending,
      "the retention sweep can reach the bukti transfer object prefix",
    ).toEqual([]);
  });

  it("still reaches the two things it IS supposed to purge — the scan is not vacuous", () => {
    // Without this, a refactor that made the retention job import nothing at all would turn both
    // assertions above into tests that pass by reaching nowhere.
    const surface = [...collectPurgeSurface(RETENTION_JOB)].map((file) =>
      file.replace(`${process.cwd()}/`, ""),
    );

    expect(surface).toContain("src/server/submissions/submission-service.ts");
    expect(surface).toContain("src/server/registration-documents/registration-document-service.ts");
  });

  it("names the payment-proof prefix somewhere, so the prefix scan targets a real string", () => {
    // Guards against the prefix being renamed while the scan above keeps looking for the old one
    // and matching nothing forever.
    const proofService = readFileSync(
      resolve(SRC_DIR, "server/finance/manual-payment-proof-service.ts"),
      "utf8",
    );

    expect(proofService).toContain("payment-proofs/");
  });
});

describe("the purge surface walker", () => {
  it("resolves a real module graph rather than returning its entry alone", () => {
    // The walker is the mechanism of all four assertions above; if it silently resolved nothing,
    // every one of them would pass vacuously.
    const surface = collectPurgeSurface(RETENTION_JOB);
    expect(surface.size).toBeGreaterThan(3);
  });

  it("walks a directory of real source files, so the paths it resolves exist", () => {
    const financeFiles = readdirSync(resolve(SRC_DIR, "server/finance")).filter(
      (name) => name.endsWith(".ts") && !name.includes(".test."),
    );
    expect(financeFiles.length).toBeGreaterThanOrEqual(5);
  });
});
