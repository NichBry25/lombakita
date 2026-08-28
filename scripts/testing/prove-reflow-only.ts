/**
 * Reports what a change did to a file's PARSED SHAPE, between any two git revisions.
 *
 * Compares syntax trees, not text. A whitespace-collapsed diff is not a proof: it calls a trailing
 * comma a change, and — the reason it was rejected here — it cannot see inside a template literal,
 * which is what an assertion harness is largely made of. `${a} vs ${b}` and `${b} vs ${a}` collapse
 * to different strings only by luck of spacing, and an edit to the cooked text of a template chunk
 * is invisible to it entirely. A parser reads the cooked value and compares that.
 *
 * Two files whose trees carry the same node kinds, the same identifiers and the same literal VALUES
 * cannot differ in behaviour. Where they do differ, this prints the differing region rather than a
 * boolean, because "not reflow-only" is the start of the question, not the answer to it.
 *
 * Usage:
 *   npm run verify:reflow-only -- <rev-a> <rev-b> <path> [<path>...]
 *
 * A revision may be any git revision, or the literal WORKTREE for the file as it is on disk.
 * Exit code: 0 when every path is reflow-only between the two revisions; 1 when any differs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const WORKTREE = "WORKTREE";

const contentAt = (revision: string, path: string): string => {
  if (revision === WORKTREE) return readFileSync(path, "utf8");
  return execFileSync("git", ["show", `${revision}:${path}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
};

/**
 * The behavioural fingerprint of a file: one entry per node, carrying what the node IS and, for
 * anything whose text can change meaning, what it SAYS.
 */
export const shapeOf = (source: string, fileName: string): string[] => {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const parts: string[] = [];
  const walk = (node: ts.Node) => {
    // Prettier drops parentheses it considers redundant, which removes a ParenthesizedExpression
    // node without changing what the expression evaluates to. Descend through it rather than
    // recording it, or the proof reports a semantic change where there is only a bracket.
    if (ts.isParenthesizedExpression(node)) {
      walk(node.expression);
      return;
    }
    parts.push(ts.SyntaxKind[node.kind] ?? String(node.kind));
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      parts.push(`name:${node.getText()}`);
    }
    // Compared by VALUE, not by how it was written: Prettier normalises quote style, and `'a\nb'`
    // and `"a\nb"` are the same string. `node.text` is the cooked value for every template chunk,
    // which is the half a whitespace diff cannot reach.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isTemplateLiteralToken(node)
    ) {
      parts.push(`text:${JSON.stringify(node.text)}`);
    }
    if (ts.isRegularExpressionLiteral(node)) parts.push(`re:${node.getText()}`);
    if (ts.isJsxText(node)) parts.push(`jsx:${JSON.stringify(node.text.trim())}`);
    node.forEachChild(walk);
  };
  tree.forEachChild(walk);
  return parts;
};

/** The one region two shapes disagree on, found by trimming the matching ends. */
export const divergence = (before: string[], after: string[]) => {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  return {
    identical: before.length === after.length && head === before.length,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
    at: head,
  };
};

const SHOWN = 60;
const preview = (label: string, entries: string[]) => {
  if (entries.length === 0) {
    console.log(`    ${label}: nothing`);
    return;
  }
  const shown = entries.slice(0, SHOWN).join(" ");
  const more = entries.length > SHOWN ? ` …and ${entries.length - SHOWN} more entries` : "";
  console.log(`    ${label} (${entries.length} entries): ${shown}${more}`);
};

const main = () => {
  const [revisionA, revisionB, ...paths] = process.argv.slice(2);
  if (!revisionA || !revisionB || paths.length === 0) {
    console.error(
      "usage: npm run verify:reflow-only -- <rev-a> <rev-b> <path> [<path>...]\n" +
        `  <rev-a>, <rev-b>  any git revision, or ${WORKTREE} for the file on disk\n` +
        "  <path>            repo-relative path, compared at both revisions",
    );
    process.exit(2);
  }

  let differing = 0;
  for (const path of paths) {
    const before = shapeOf(contentAt(revisionA, path), path);
    const after = shapeOf(contentAt(revisionB, path), path);
    const result = divergence(before, after);

    if (result.identical) {
      console.log(`REFLOW ONLY   ${path}  (${before.length} nodes, trees identical)`);
      continue;
    }

    differing += 1;
    console.log(
      `TREES DIFFER  ${path}  (${before.length} → ${after.length} nodes; ` +
        `first ${result.at} identical)`,
    );
    preview("removed", result.removed);
    preview("added", result.added);
  }

  console.log(
    `\n${paths.length} path(s) compared ${revisionA}..${revisionB}; ` +
      `${differing} differ in parsed shape.`,
  );
  process.exit(differing === 0 ? 0 : 1);
};

// Exported as functions and run only when this file IS the entry point, so the test beside it can
// exercise the comparison without spawning a process or touching git.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
