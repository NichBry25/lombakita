// @vitest-environment node

// EVERY SEND SITE REACHES THE GUARD, WITH THE ADDRESS IT ACTUALLY SENDS TO.
//
// `resolveEmailDelivery` refuses reserved recipients and returns the API key, so a site that skips
// it has no key and cannot send. That makes omission hard, but it does not make two other mistakes
// hard: resolving for one address and sending to another, and resolving AFTER the send. Neither is
// visible to a test that only checks the guard exists, and a grep for the call name sees both as
// fine.
//
// Resolved against the syntax tree rather than a line window: the question is which expression
// reaches which call in what order, and that is not a textual property.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const SEND_FILES = [
  "src/server/notifications/notification-email.ts",
  "src/server/institution-invitations/invitation-email.ts",
  "src/server/institution-verification/verification-email.ts",
  "src/server/teams/team-email.ts",
  "src/server/auth/email-verification.ts",
] as const;

// The count is part of the declaration. A new send function that nobody wired into the guard would
// otherwise arrive silently, and this file would keep reporting that everything it knows about is
// fine.
const EXPECTED_SEND_FUNCTIONS = 17;

/** Names that both refuse a reserved recipient and yield the credential a send needs. */
const RESOLVERS = new Set(["resolveEmailDelivery", "resolveNotificationDelivery"]);
const SENDERS = new Set(["send", "sendMail"]);

type SendSite = {
  file: string;
  fn: string;
  resolvedAddress: string | null;
  sentAddress: string | null;
  resolvesBeforeSending: boolean;
};

const calleeName = (node: ts.CallExpression): string =>
  ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : ts.isIdentifier(node.expression)
      ? node.expression.text
      : "";

/** The `to` an argument list carries, whether passed as a property or positionally. */
const addressArgument = (call: ts.CallExpression, source: ts.SourceFile): string | null => {
  for (const argument of call.arguments) {
    if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "to"
        ) {
          return property.initializer.getText(source);
        }
      }
    }
  }
  // `resolveNotificationDelivery(kind, toEmail)` takes it positionally.
  const positional = call.arguments[1];
  return positional && !ts.isObjectLiteralExpression(positional)
    ? positional.getText(source)
    : null;
};

const sendSitesIn = (file: string): SendSite[] => {
  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: SendSite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.startsWith("send") &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      let resolvedAddress: string | null = null;
      let resolvedAt = Number.POSITIVE_INFINITY;
      let sentAddress: string | null = null;
      let sentAt = Number.POSITIVE_INFINITY;

      const walkBody = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner)) {
          const name = calleeName(inner);
          if (RESOLVERS.has(name) && resolvedAddress === null) {
            resolvedAddress = addressArgument(inner, source);
            resolvedAt = inner.getStart(source);
          }
          if (SENDERS.has(name) && sentAddress === null) {
            sentAddress = addressArgument(inner, source);
            sentAt = inner.getStart(source);
          }
        }
        ts.forEachChild(inner, walkBody);
      };
      ts.forEachChild(node.initializer, walkBody);

      if (sentAddress !== null || resolvedAddress !== null) {
        sites.push({
          file,
          fn: node.name.text,
          resolvedAddress,
          sentAddress,
          resolvesBeforeSending: resolvedAt < sentAt,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return sites;
};

const sites = SEND_FILES.flatMap(sendSitesIn);

describe("outbound email send sites", () => {
  it("finds every send function the five email modules declare", () => {
    expect(sites).toHaveLength(EXPECTED_SEND_FUNCTIONS);
  });

  it.each(sites.map((site) => [`${site.fn} (${site.file})`, site] as const))(
    "%s resolves delivery for the address it sends to, before sending",
    (_label, site) => {
      expect(site.resolvedAddress).not.toBeNull();
      expect(site.sentAddress).not.toBeNull();
      // Resolving for one address and sending to another would pass the guard on a routable
      // address and hand a reserved one to the provider.
      expect(site.sentAddress).toBe(site.resolvedAddress);
      // Resolving below the send is the move the guard cannot survive: the message is already gone.
      expect(site.resolvesBeforeSending).toBe(true);
    },
  );
});
