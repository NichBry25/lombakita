/**
 * Every database write a seed file issues directly, found from the syntax tree.
 *
 * WHY THIS IS NOT A LIST OF ROUTED FILES. An allow-list of "the fixtures we route" answers "are the
 * declared ones clean?" and never "is the declaration complete?", which is how
 * `GOVERNED_FIXTURE_FILES` was blind to a defect introduced in the same changeset that built it,
 * and how the discovery added to fix that had the identical defect one level up. The acceptance
 * question for any mechanism here is the same one that caught the original: if someone adds a raw
 * write to the seed, what fails? A list of files fails nothing, because the file was already on it.
 *
 * WHY IT IS NOT A COUNT OF `.insert(` CALLS EITHER. That check has already failed this exact test
 * once: LAUNCH-D5 measured its population over drizzle-builder `.insert(table)` calls, concluded
 * nine fixture files, and missed `seed-test-matrix.ts` entirely (52 raw `INSERT INTO` statements
 * across 37 tables, the largest direct-insert fixture in the repository) because the seed spells
 * its writes as tagged templates rather than as builder calls. A mechanism that recognises the
 * spellings someone thought of is blind to the one they did not.
 *
 * WHY IT COUNTS ONLY RAW WRITES. An earlier version also counted "routed" writes, calls to
 * anything imported from `src/server/**`, and reported the matrix seed as partly routed. The one
 * call it found was the seed's own service loader, and the service the seed actually called through
 * it was invisible, because a dynamic import binds a namespace and the census only understood named
 * bindings. A number that is measured by a method known to be blind to its own subject is not a
 * measurement. The raw count is defined positively, at the write site, and that is the only number
 * here: a file's obligation is a ceiling on it.
 *
 * SO IT IS DERIVED FROM THE SYNTAX TREE, AND IT REFUSES WHAT IT CANNOT CLASSIFY (Rule 38). Every
 * write-shaped expression in the file is found by walking the AST rather than by matching lines. A
 * write it can classify is counted against its table. A write-shaped expression that matches no
 * form it can count THROWS, and the census reports nothing for that file: skipping an
 * unclassifiable input is fail-open, and a gate that runs but cannot fail a merge is not a gate.
 * The forms it refuses are enumerated at `refuse*` below, each with the spelling it exists to stop.
 *
 * Resolved against the AST rather than a line window for the reason Rule 37 gives: a grep for a
 * behaviour finds only the spelling you guessed. `sql` inside a comment, a SQL keyword inside a
 * string, and a write split across four lines are all things a regex gets wrong in both directions.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

/** One direct write: the file and line it is issued from, and the table it names. */
export type WriteSite = {
  file: string;
  line: number;
  subject: string;
};

/**
 * A SQL statement that CHANGES rows, recognised only where the verb LEADS a statement.
 *
 * Leading, because the same words occur mid-statement meaning something else: `ON CONFLICT DO
 * UPDATE SET` is one INSERT and not an INSERT plus an UPDATE of a table named `SET`. A read is not
 * a write and is not this gate's business. A seed that queries directly to assert a post-condition
 * is doing the right thing, and demanding it route its reads through services would make the
 * assertion measure the service rather than the database.
 */
const WRITE_STATEMENT =
  /(?:^|;)\s*(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+("?[a-z_][a-z0-9_]*"?)/gi;

/** A write verb at the END of a template segment: the table name that follows is a substitution. */
const WRITE_VERB_AWAITING_TABLE =
  /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s*$/i;

/**
 * Statement-leading keywords that can change rows in ways this census does not count.
 *
 * A CTE can wrap a data-modifying statement, `MERGE` and `COPY` write rows, and DDL rewrites the
 * table itself. None of these belongs in a seed, and none is counted, so a template that starts
 * with one is refused rather than scored zero.
 */
const UNCOUNTED_MUTATING_STATEMENT =
  /(?:^|;)\s*(with|merge|copy|create|alter|drop|refresh|call|do)\b/i;

/**
 * Drizzle's builder spellings of the same three verbs.
 *
 * THE METHOD NAME ALONE DOES NOT IDENTIFY A DATABASE WRITE, and assuming it did produced two false
 * findings on the first run: `cipher.update(secret)` and `hash.update(raw)` were reported as writes
 * to tables named `mfaSecret` and `raw`. Node's crypto objects carry an `update` method and so does
 * every stream-shaped API in the language.
 *
 * What actually identifies a drizzle write is its ARGUMENT: a table object reached through the
 * schema module. That is an import-graph fact (you cannot name a table without importing the
 * module that defines it), so classifying by the argument is a CLASSIFICATION and not a skip. A
 * `.update()` whose argument is not a schema table is not a database write, which is a different
 * statement from "not one this gate knows about".
 */
const BUILDER_WRITE_METHODS: ReadonlySet<string> = new Set(["insert", "update", "delete"]);

/** Modules that export the drizzle table objects a builder write names. */
const SCHEMA_MODULE_PATTERN = /(^|\/)server\/db\/schema$/;

/**
 * The postgres.js escape hatch that runs an arbitrary string as SQL.
 *
 * Whatever a seed passes it, the census cannot see a table in it, so its presence is refused
 * outright rather than the argument being inspected: an inspection that succeeded on the strings
 * someone thought of would fail on the first one built at run time.
 */
const ARBITRARY_SQL_METHOD = "unsafe";

/**
 * A plain string that is itself a write statement, wherever it is about to be sent.
 *
 * Each form carries enough of its own syntax that prose cannot match it: a seed is full of copy
 * that starts with "Update" or "Create", and none of it goes on to name a table and SET a column.
 */
const STRING_SHAPED_WRITE =
  /^\s*(insert\s+into\s+\S|update\s+\S+\s+set\b|delete\s+from\s+\S|truncate\s+(?:table\s+)?\S|with\s+\S+\s+as\s*\(|merge\s+into\s+\S|copy\s+\S+\s+(?:from|to)\b|create\s+(?:table|index|schema|view)\b|alter\s+table\b|drop\s+(?:table|index|schema|view)\b)/i;

const isSchemaModule = (specifier: string): boolean => SCHEMA_MODULE_PATTERN.test(specifier);

/**
 * How the schema module is bound in one file: table objects imported by name, and namespaces the
 * whole module is imported as (`import * as schema`), through which `schema.users` names a table.
 */
type SchemaBindings = { tables: ReadonlySet<string>; namespaces: ReadonlySet<string> };

const schemaBindings = (source: ts.SourceFile): SchemaBindings => {
  const tables = new Set<string>();
  const namespaces = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isSchemaModule(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings
    ) {
      const named = node.importClause.namedBindings;

      if (ts.isNamedImports(named)) {
        for (const element of named.elements) tables.add(element.name.text);
      }

      if (ts.isNamespaceImport(named)) {
        namespaces.add(named.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return { tables, namespaces };
};

/** The table a builder write names, or null when the argument is not a schema table at all. */
const builderWriteSubject = (argument: ts.Expression, schema: SchemaBindings): string | null => {
  if (ts.isIdentifier(argument) && schema.tables.has(argument.text)) {
    return argument.text;
  }

  if (
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    schema.namespaces.has(argument.expression.text)
  ) {
    return argument.name.text;
  }

  return null;
};

/** The literal segments of a template, in order, with the substitutions removed. */
const templateSegments = (node: ts.TemplateLiteral): string[] => {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }

  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
};

/** Every write statement in a template's text, by the table each names. */
const writeStatementsIn = (text: string): string[] =>
  [...text.matchAll(WRITE_STATEMENT)].map((matched) => matched[2]!.replace(/"/g, ""));

/** Thrown for a write-shaped expression the census cannot count. Rule 38: refuse, never skip. */
export class CensusRefusal extends Error {
  constructor(file: string, line: number, reason: string) {
    super(`the census refuses ${file}:${line}: ${reason}`);
    this.name = "CensusRefusal";
  }
}

/**
 * Every write site in one file.
 *
 * Throws `CensusRefusal` on a write-shaped expression it cannot classify. That is the Rule 38 half
 * and it is the half that matters: a census that silently drops what it does not recognise reports
 * a smaller population than exists and reads as though it covered everything.
 */
export const censusWriteSites = (file: string): WriteSite[] => {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const schema = schemaBindings(source);
  const sites: WriteSite[] = [];

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const refuse = (node: ts.Node, reason: string): never => {
    throw new CensusRefusal(file, lineOf(node), reason);
  };

  const countTaggedTemplate = (node: ts.TaggedTemplateExpression): void => {
    const segments = templateSegments(node.template);
    const joined = segments.join(" ");

    // `INSERT INTO ${sql(table)}`: the table is decided at run time and the census cannot name
    // it, so a count would be a count of writes to nowhere in particular.
    if (segments.slice(0, -1).some((segment) => WRITE_VERB_AWAITING_TABLE.test(segment))) {
      refuse(node, "the table this statement writes is a substitution, not a name in the source");
    }

    const uncounted = UNCOUNTED_MUTATING_STATEMENT.exec(joined);

    if (uncounted) {
      refuse(
        node,
        `a statement leading with ${uncounted[1]!.toUpperCase()} can change rows in a way the ` +
          "census does not count",
      );
    }

    const tables = writeStatementsIn(joined);

    // One site is one statement. Two statements in one template would be one site holding two
    // writes, and the ceiling would be off by one for every such template.
    if (tables.length > 1) {
      refuse(
        node,
        `one template holds ${tables.length} write statements; issue each as its own template`,
      );
    }

    for (const subject of tables) {
      sites.push({ file, line: lineOf(node), subject });
    }
  };

  const countCall = (node: ts.CallExpression): void => {
    const callee = node.expression;

    if (!ts.isPropertyAccessExpression(callee)) {
      return;
    }

    if (callee.name.text === ARBITRARY_SQL_METHOD) {
      refuse(
        node,
        "`.unsafe()` runs whatever string it is given, and the census cannot see a table in it",
      );
    }

    // A drizzle builder write: `db.insert(table)`, `tx.update(schema.table)`. Identified by its
    // schema table argument, never by the method name alone; see BUILDER_WRITE_METHODS.
    if (BUILDER_WRITE_METHODS.has(callee.name.text) && node.arguments.length > 0) {
      const subject = builderWriteSubject(node.arguments[0]!, schema);

      if (subject !== null) {
        sites.push({ file, line: lineOf(node), subject });
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      countTaggedTemplate(node);
    }

    if (ts.isCallExpression(node)) {
      countCall(node);
    }

    // A write statement written as a plain string or an untagged template is invisible as a
    // tagged template and could be handed to any client method. It is refused wherever it sits;
    // the fix is to spell it as a tagged template the census can count.
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !ts.isTaggedTemplateExpression(node.parent) &&
      STRING_SHAPED_WRITE.test(node.text)
    ) {
      refuse(
        node,
        "a write statement in a plain string cannot be counted; write it as a tagged template",
      );
    }

    if (
      ts.isTemplateExpression(node) &&
      !ts.isTaggedTemplateExpression(node.parent) &&
      STRING_SHAPED_WRITE.test(node.head.text)
    ) {
      refuse(node, "a write statement in an untagged template cannot be counted; tag it");
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return sites;
};

/** What the census found, reduced to the number a ratchet can hold and the tables behind it. */
export const summariseCensus = (
  sites: readonly WriteSite[],
): { raw: number; rawTables: string[] } => ({
  raw: sites.length,
  rawTables: [...new Set(sites.map((site) => site.subject))].sort(),
});

/**
 * The seed files this census covers, and what each one's routing obligation is.
 *
 * DECLARED WITH A REASON PER ROW, the same shape as `EXEMPT_SEND_CAPABLE_FILES` in the recipient
 * gate. The declaration is not the population (`censusWriteSites` finds the writes); it is the
 * statement of what each file is ALLOWED to be, which is the thing a reviewer can disagree with.
 */
export type SeedFileObligation = {
  file: string;
  /** The most raw writes this file may contain. May go DOWN and never up. */
  rawCeiling: number;
  reason: string;
};

/**
 * The ratchet.
 *
 * WHAT THIS DOES AND DOES NOT ENFORCE, stated plainly. It cannot make a raw write impossible: the
 * numbers below are editable like any other. What it does is move a raw write out of a 2,000-line
 * seed and onto a single line that says how much of it is unrouted, so ADDING one is a deliberate
 * edit to a stated number that a reviewer sees in the diff, and ROUTING one forces that number
 * down in the same commit. The exact-equality assertion beside this is what forces the second half:
 * a ceiling left above what the file actually holds is itself a failure, so debt paid down cannot
 * quietly leave headroom for new debt.
 *
 * These are LITERALS, not sums over the census. Deriving the bound from the thing it bounds would
 * make the assertion true by construction and measure nothing, which is the defect this whole
 * mechanism exists to avoid shipping.
 */
export const SEED_FILE_OBLIGATIONS: readonly SeedFileObligation[] = Object.freeze([
  {
    file: "scripts/seed-test-matrix.ts",
    rawCeiling: 38,
    reason:
      "the matrix seed. What an institution is created holding comes from the production " +
      "constant rather than a literal, and nothing in this file elevates a tier or enrols a " +
      "factor any more; those travel the review and enrolment services from the operator " +
      "module. The raw writes that remain are this phase's outstanding work, and this number " +
      "is the measure of it: routing a table lowers it, and adding a raw write fails the " +
      "suite unless someone raises it deliberately, in a diff, with a reason",
  },
  {
    file: "scripts/seed/manual-payment-lane.ts",
    rawCeiling: 23,
    reason:
      "the money lane, DELIBERATELY UNROUTED and Phase 4's. DEC-0133 makes the payment, event " +
      "and accrual tables append-only so a routed re-runnable seed could not clean up after " +
      "itself, and several rows exist precisely BECAUSE the service refuses them " +
      "(`seed-comp-b-unpayable` is priced while its institution meets none of the charging " +
      "conditions, and that refusal is the fixture). This ceiling is not debt and is not " +
      "expected to fall in Phase 2. It fell by three when the competition price writes moved " +
      "back to the matrix seed, where the fixtures they price are declared: a price is part of " +
      "what a competition is, and holding it here left three paid competitions unpriced after a " +
      "reset while their copy went on claiming a price",
  },
  {
    file: "scripts/seed/operator-accounts.ts",
    rawCeiling: 4,
    reason:
      "the operator accounts: three upserts for the users, credentials and profiles of accounts " +
      "no product path can create (LAUNCH-D47, Block C2's question), and the factor reset that " +
      "lets the production enrolment path run again. The factors themselves and the two " +
      "verification reviews travel the services and are not here",
  },
  {
    file: "scripts/seed-operator-accounts.ts",
    rawCeiling: 0,
    reason:
      "an entry point. It reads the database to confirm the matrix is present and to assert the " +
      "end state; every write is in the module it imports",
  },
  {
    file: "scripts/seed-manual-payment-lane.ts",
    rawCeiling: 0,
    reason: "an entry point. Every write is in the lane module it imports",
  },
] as const);
