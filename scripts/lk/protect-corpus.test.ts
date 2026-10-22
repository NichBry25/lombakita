// @vitest-environment node

/**
 * The pin on the old protect script: the file is read from the proof folder of the docs checkout
 * and refused unless its git blob id is the pinned one. The expected id comes from `git hash-object`,
 * so the comparison is not checked against the code that makes it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { corpusFolderOf, OLD_PROTECT_BLOB_ID, readPinnedOldProtectScript } from "./protect-corpus";

const REAL_DOCS = process.env.DENY_PROOF_DOCS_ROOT ?? join(process.cwd(), "docs");
const REAL_PROTECT = join(REAL_DOCS, ".claude/hooks/check-protected-file.sh");
const OLD_SCRIPT_NAME = "old-protect-script.sh";

const workspace = mkdtempSync(join(tmpdir(), "lk-protect-corpus-test-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const blobIdByGit = (content: Buffer): string => {
  const hashed = spawnSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" });
  return hashed.stdout.trim();
};

const docsRootHolding = (content: Buffer): string => {
  const docsRoot = mkdtempSync(join(workspace, "docs-"));
  mkdirSync(corpusFolderOf(docsRoot), { recursive: true });
  writeFileSync(join(corpusFolderOf(docsRoot), OLD_SCRIPT_NAME), content);
  return docsRoot;
};

describe.skipIf(!existsSync(REAL_PROTECT))(
  "the old protect script of the docs proof folder (needs docs/)",
  () => {
    const realBytes = (): Buffer => readFileSync(join(corpusFolderOf(REAL_DOCS), OLD_SCRIPT_NAME));

    it("is read from the docs checkout and has the pinned git blob id", () => {
      const content = readPinnedOldProtectScript(REAL_DOCS);
      expect(blobIdByGit(content)).toBe(OLD_PROTECT_BLOB_ID);
      expect(content.equals(realBytes())).toBe(true);
    });

    it("is refused when one byte differs, naming the expected and the found blob id", () => {
      const changed = Buffer.from(realBytes());
      changed.writeUInt8(changed.readUInt8(0) ^ 1, 0);
      const docsRoot = docsRootHolding(changed);
      const found = blobIdByGit(changed);
      expect(found).not.toBe(OLD_PROTECT_BLOB_ID);
      expect(() => readPinnedOldProtectScript(docsRoot)).toThrow(
        `the old protect script has blob id ${found}, expected ${OLD_PROTECT_BLOB_ID}`,
      );
    });

    it("prints no script text when it refuses a changed copy", () => {
      const changed = Buffer.from(realBytes());
      const last = changed.length - 1;
      changed.writeUInt8(changed.readUInt8(last) ^ 1, last);
      const docsRoot = docsRootHolding(changed);
      const firstLine = realBytes().toString("utf8").split("\n")[0];
      let message = "";
      try {
        readPinnedOldProtectScript(docsRoot);
      } catch (problem) {
        message = (problem as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(firstLine);
    });
  },
);
