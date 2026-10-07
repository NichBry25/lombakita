// @vitest-environment node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const readRootSource = (name: string): string => readFileSync(resolve(process.cwd(), name), "utf8");

const readClientSource = (): string => readRootSource("instrumentation-client.ts");

const readClientInitOptions = (): ts.ObjectLiteralExpression => {
  const source = ts.createSourceFile(
    "instrumentation-client.ts",
    readClientSource(),
    ts.ScriptTarget.Latest,
    true,
  );
  const calls = source.statements.filter(ts.isExpressionStatement);
  const init = calls.find((statement) => {
    const expression = statement.expression;
    return (
      ts.isCallExpression(expression) && expression.expression.getText(source) === "Sentry.init"
    );
  });
  expect(init, "client initialisation must call Sentry.init at module scope").toBeDefined();
  const call = init!.expression as ts.CallExpression;
  const options = call.arguments[0];
  expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
  return options as ts.ObjectLiteralExpression;
};

const clientOptionText = (name: string): string | undefined => {
  const options = readClientInitOptions();
  const explicitProperties = options.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
  );
  expect(explicitProperties, "client options must be explicit").toBe(true);
  const assignments = options.properties.filter(ts.isPropertyAssignment);
  const matches = assignments.filter(
    (property) => (property.name as ts.Identifier | ts.StringLiteral).text === name,
  );
  expect(matches.length, `client option ${name} must not be duplicated`).toBeLessThanOrEqual(1);
  const property = matches[0];
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  return property.initializer.getText();
};

// These tripwires check source configuration. Only a production run proves SDK initialisation.
describe("Sentry Next.js instrumentation", () => {
  it("has instrumentation-client.ts at the repository root", () => {
    expect(existsSync(resolve(process.cwd(), "instrumentation-client.ts"))).toBe(true);
  });

  it("has no legacy sentry.client.config.* file at the repository root", () => {
    const legacyFiles = readdirSync(process.cwd()).filter((name) =>
      name.startsWith("sentry.client.config."),
    );
    expect(legacyFiles).toEqual([]);
  });

  it("exports the request-error hook and retains both runtime config imports", () => {
    const source = readRootSource("instrumentation.ts");
    expect(source).toMatch(/export const onRequestError = Sentry\.captureRequestError;/);
    expect(source).toContain("export async function register()");
    expect(source).toContain('await import("./sentry.server.config")');
    expect(source).toContain('await import("./sentry.edge.config")');
  });

  it("reads NEXT_PUBLIC_SENTRY_DSN for the browser DSN", () => {
    expect(clientOptionText("dsn")).toBe("process.env.NEXT_PUBLIC_SENTRY_DSN");
  });

  it("sets the browser tracesSampleRate to 0", () => {
    expect(clientOptionText("tracesSampleRate")).toBe("0");
  });

  it("enables no replay integration", () => {
    const source = readClientSource();
    expect(source).not.toMatch(/replay/i);
  });

  it("does not enable sendDefaultPii", () => {
    const value = clientOptionText("sendDefaultPii");
    expect(value === undefined || value === "false").toBe(true);
  });
});
