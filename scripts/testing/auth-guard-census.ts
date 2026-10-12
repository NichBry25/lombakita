import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  AUTH_SOURCE_POPULATION,
  censusMfaOptOutNames,
  enumerateRepositorySourceFiles,
} from "../../src/server/auth/unsatisfied-mfa-opt-out";

const sourceFiles = enumerateRepositorySourceFiles();
const sessionPages: { file: string; lines: number[] }[] = [];
const enrolmentCalls: { file: string; line: number; call: string }[] = [];
for (const file of sourceFiles) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const sessionNames = new Set(["getCurrentSession"]);
  const enrolmentNames = new Set(["startMfaEnrolment"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const entry of bindings.elements) {
      const imported = (entry.propertyName ?? entry.name).text;
      if (imported === "getCurrentSession") sessionNames.add(entry.name.text);
      if (imported === "startMfaEnrolment") enrolmentNames.add(entry.name.text);
    }
  }
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (name && sessionNames.has(name) && /\/page\.tsx$/.test(file)) lines.push(line);
      if (name && enrolmentNames.has(name))
        enrolmentCalls.push({ file, line, call: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (lines.length > 0) sessionPages.push({ file, lines });
}
console.log(
  JSON.stringify(
    {
      population: AUTH_SOURCE_POPULATION.arguments,
      scannedFiles: sourceFiles.length,
      optOutNames: censusMfaOptOutNames(),
      sessionPages,
      enrolmentCalls,
    },
    null,
    2,
  ),
);
