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

/**
 * Object-storage prefixes holding FINANCIAL EVIDENCE, which retention may never reach at any age.
 *
 * Both the literal prefix and the function that builds it, because a module can name either one and
 * a scan that knows only the literal misses `buildX()` used without ever spelling the string.
 *
 * A competition ending is not a reason to destroy the record of who paid for it, or of where they
 * were told to send the money. Nothing here is purged, ever.
 */
const EVIDENCE_PREFIX_MARKERS = [
  "payment-proofs/",
  "buildManualProofObjectPrefix",
  "payment-instructions/",
  "buildQrisObjectPrefix",
] as const;

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

  it("reaches no module that lists a FINANCIAL EVIDENCE object prefix for deletion", () => {
    // Object storage is the other half. A proof row surviving while its FILE is swept is the same
    // loss: the evidence is the image, not the row that points at it.
    //
    // TWO PREFIXES, not one, and the second is newer and easier to forget. A QRIS code is the
    // organiser's published means of being paid: the payer scans it, transfers against it, and the
    // instruction snapshot on their payment records that it was what they were shown. Purging it
    // destroys the counterparty half of every transfer made against it, which is the same class of
    // loss as deleting the receipt — and unlike a bukti transfer, nothing about the word "QRIS"
    // announces that it is financial evidence.
    const surface = collectPurgeSurface(RETENTION_JOB);

    const offending: string[] = [];
    for (const file of surface) {
      const source = readFileSync(file, "utf8");
      for (const marker of EVIDENCE_PREFIX_MARKERS) {
        if (source.includes(marker)) {
          offending.push(`${file.replace(`${process.cwd()}/`, "")} (${marker})`);
        }
      }
    }

    expect(
      offending,
      "the retention sweep can reach a financial evidence object prefix",
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

  it("finds every scanned marker somewhere in the source, so no scan targets a dead string", () => {
    // Guards against a prefix being renamed while the scan above keeps looking for the old one and
    // matching nothing forever — a scan for a string that no longer exists reports clean on every
    // file in the graph, which is the exact shape of a check that has quietly stopped checking.
    //
    // Asserted per MARKER rather than per file, so adding a third evidence prefix to the list above
    // without implementing it fails here rather than silently widening a scan that finds nothing.
    const sources = [
      readFileSync(resolve(SRC_DIR, "server/finance/manual-payment-proof-service.ts"), "utf8"),
      readFileSync(resolve(SRC_DIR, "server/institutions/payment-instructions-service.ts"), "utf8"),
    ].join("\n");

    for (const marker of EVIDENCE_PREFIX_MARKERS) {
      expect(sources, `nothing defines "${marker}" — the scan for it can never match`).toContain(
        marker,
      );
    }
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
