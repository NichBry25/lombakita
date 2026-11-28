// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The population (Rule 38), declared as data: every .ts file under src/server whose name does not
// end in .test.ts. A file this test cannot read fails it.
const SERVER_ROOT = join(process.cwd(), "src/server");

const TICK_COLUMN_KEYS: readonly string[] = [
  "tickPath",
  "tickDomain",
  "nameCheckedAt",
  "nameProofDueAt",
  "nameProofRemindedAt",
];

// The files that may write a tick column, and the columns each may write. The sweep marks a
// reminder as sent, so name-check-service.ts may write that one column and no other.
const ALLOWED_TICK_COLUMNS_BY_FILE: Readonly<Record<string, readonly string[]>> = {
  "src/server/institution-verification/tick-transition.ts": TICK_COLUMN_KEYS,
  "src/server/accounts/account-deidentification-service.ts": TICK_COLUMN_KEYS,
  "src/server/db/schema.ts": TICK_COLUMN_KEYS,
  "src/server/institution-verification/name-check-service.ts": ["nameProofRemindedAt"],
};

const listSourceFiles = (): string[] =>
  readdirSync(SERVER_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .filter((entry) => !entry.name.endsWith(".test.ts"))
    .map((entry) => join(entry.parentPath, entry.name));

// The text between the parentheses of every `.set(` call, balanced by depth.
const setCallArguments = (source: string): string[] => {
  const calls: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(".set(", searchFrom);
    if (start === -1) return calls;

    let depth = 1;
    let cursor = start + ".set(".length;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "(") depth += 1;
      if (source[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    calls.push(source.slice(start + ".set(".length, cursor - 1));
    searchFrom = cursor;
  }
};

const tickColumnsWrittenIn = (source: string): string[] =>
  setCallArguments(source).flatMap((callArguments) =>
    TICK_COLUMN_KEYS.filter((key) => new RegExp(`\\b${key}\\b`).test(callArguments)),
  );

describe("the single writer of the tick columns", () => {
  it("finds a tick column written in a .set( call", () => {
    expect(tickColumnsWrittenIn("tx.update(t).set({ tickPath: null, updatedAt: x })")).toEqual([
      "tickPath",
    ]);
    expect(tickColumnsWrittenIn("tx.update(t).set(updates)")).toEqual([]);
  });

  it("only tick-transition.ts writes the tick columns", () => {
    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(0);

    const hits = files
      .map((file) => ({ file: relative(process.cwd(), file), source: readFileSync(file, "utf8") }))
      .map(({ file, source }) => ({
        file,
        columns: tickColumnsWrittenIn(source).filter(
          (column) => !(ALLOWED_TICK_COLUMNS_BY_FILE[file] ?? []).includes(column),
        ),
      }))
      .filter(({ columns }) => columns.length > 0);

    expect(hits).toEqual([]);
  });
});
