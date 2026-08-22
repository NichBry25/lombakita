/**
 * Proves a Prettier pass changed nothing but layout.
 *
 * Compares PARSED SYNTAX TREES, not text. A whitespace-stripped diff calls a trailing comma a
 * change, and Prettier adds or removes one every time it wraps or joins an argument list; a raw
 * token scan mis-lexes backticks and slashes without a parser's context. Two files whose trees
 * carry the same node kinds and the same literal texts cannot differ in behaviour.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const shape = (source: string, fileName: string): string => {
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
    parts.push(String(node.kind));
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      parts.push(JSON.stringify(node.getText()));
    }
    // A string is compared by its VALUE, not by how it was written. Prettier normalises quote
    // style, and `'a\nb'` and `"a\nb"` are the same string — comparing raw text would report a
    // behaviour change over a quote character.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isTemplateLiteralToken(node)
    ) {
      parts.push(JSON.stringify(node.text));
    }
    if (ts.isRegularExpressionLiteral(node)) {
      parts.push(JSON.stringify(node.getText()));
    }
    if (ts.isJsxText(node)) parts.push(JSON.stringify(node.text.trim()));
    node.forEachChild(walk);
  };
  tree.forEachChild(walk);
  return parts.join("|");
};

const [beforeRoot, listPath] = process.argv.slice(2);
if (!beforeRoot || !listPath) {
  console.error(
    "usage: node --import tsx scripts/testing/prove-reflow-only.ts <before-dir> <file-list>\n" +
      "  <before-dir>  a copy of the files taken BEFORE the format pass, at the same paths\n" +
      "  <file-list>   newline-separated repo-relative paths, one per file that was reformatted",
  );
  process.exit(2);
}
const files = readFileSync(listPath, "utf8").split("\n").filter(Boolean);

let differing = 0;
for (const file of files) {
  const before = shape(readFileSync(`${beforeRoot}/${file}`, "utf8"), file);
  const after = shape(readFileSync(file, "utf8"), file);
  if (before !== after) {
    differing += 1;
    console.log(`  TREES DIFFER  ${file}`);
  }
}
console.log(`${files.length} files compared; ${differing} differ in parsed shape.`);
process.exit(differing === 0 ? 0 : 1);
