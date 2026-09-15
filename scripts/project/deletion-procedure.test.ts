// @vitest-environment node
//
// The procedure document, held to the census and to the surface it names.
//
// WHAT THESE TESTS ARE FOR. The procedure is hand-written prose with fenced statements in it, and
// the harness executes whatever those statements say. So the failure mode is not a broken function —
// it is a document that has drifted from the graph it claims to walk, or that quotes a policy
// sentence the policy does not contain. Each assertion below fails on a change to the schema, the
// census or the published policy, and names the store or the sentence rather than the shape it broke.
//
// The one assertion that cannot exist here is "the procedure was run": that needs a database. What
// is checked here is what can be checked without one — that the document covers the population the
// census derives, and that it does so in the order it says it does.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPANY } from "@/config/company";
import { blockingForeignKeys, R2_PREFIXES } from "./deletion-census";
import {
  DEMONSTRATION_CASES,
  parseProcedure,
  PROCEDURE_PATH,
  type ProcedureStep,
} from "./run-deletion-procedure";

const POLICY_PAGE = "src/app/kebijakan-privasi/page.tsx";

const document = readFileSync(PROCEDURE_PATH, "utf8");
const steps = parseProcedure(document);

const stepNamed = (name: string): ProcedureStep => {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`the procedure declares no step named \`${name}\``);
  return step;
};

const sqlSteps = steps.filter((step) => step.kind === "sql");

/**
 * The markdown blockquotes, one entry per paragraph, with the emphasis markers and the line breaks
 * taken out. A quotation split across three source lines is one passage, and comparing it line by
 * line would pass on a document that quoted three separate fragments of the policy.
 */
const quotedPassages = (markdown: string): string[] => {
  const passages: string[] = [];
  let run: string[] = [];

  for (const line of markdown.split("\n")) {
    if (line.startsWith("> ")) {
      run.push(line.slice(2).replaceAll("**", ""));
      continue;
    }
    if (run.length > 0) passages.push(run.join(" "));
    run = [];
  }
  if (run.length > 0) passages.push(run.join(" "));

  return passages.map((passage) => passage.replace(/\s+/g, " ").trim());
};

/**
 * The published policy as readable prose, so a quotation can be compared against it.
 *
 * The page is JSX, so three things have to be undone before a sentence in it can be compared with a
 * sentence in a markdown blockquote: the support address is an interpolated expression, the
 * explicit spaces between an anchor and its neighbours are `{" "}`, and the emphasis is a tag. Tags
 * are removed rather than replaced with a space, because replacing them would put a space before the
 * full stop that follows a link and no quotation would ever match again.
 */
const policyProse = (): string =>
  readFileSync(POLICY_PAGE, "utf8")
    .replaceAll("{COMPANY.supportEmail}", COMPANY.supportEmail)
    .replace(/\{"\s*"\}/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("the procedure document", () => {
  it("parses into the six steps it describes, in the order it describes them", () => {
    // The harness refuses an unknown fence and a duplicate name on the way through, so reaching this
    // assertion at all is the first result: the document is well formed against the grammar it
    // declares in its own fence table.
    expect(steps.map((step) => step.name)).toEqual([
      "resolve",
      "capture-identities",
      "capture-object-keys",
      "blockers",
      "delete",
      "remove-objects",
    ]);
  });

  it("gives every statement the user id as a parameter", () => {
    // The harness hands `[userId]` to every block. A statement that does not filter on `$1` still
    // runs — Postgres accepts an unused parameter — so a `delete` that lost its `where` clause would
    // delete every account and report the row count as success.
    expect(sqlSteps.length).toBeGreaterThan(0);
    for (const step of sqlSteps) {
      expect(step.body, `step \`${step.name}\` does not filter on the user id`).toContain("$1");
    }
  });

  it("issues exactly one destructive statement, and it is the one step named for it", () => {
    const destructive = sqlSteps
      .filter((step) => /\bdelete\s+from\b/i.test(step.body))
      .map((step) => step.name);

    expect(destructive).toEqual(["delete"]);
    expect(stepNamed("delete").body).toContain("delete from users where id = $1");
  });

  it("captures what a deletion destroys before the statement that destroys it", () => {
    // The one ordering in the procedure that is unrecoverable. Every user- and registration-scoped
    // object key lives on a row the delete removes, and for three of the prefixes the middle
    // segments are recorded nowhere else — so a run that deletes first has thrown away its own index
    // and will report a clean bucket it never enumerated.
    const order = steps.map((step) => step.name);
    const deleteAt = order.indexOf("delete");

    for (const yields of ["identity-literals", "object-keys"]) {
      const producer = steps.find((step) => step.yields === yields);
      expect(producer, `no step yields \`${yields}\``).toBeDefined();
      expect(
        order.indexOf(producer!.name),
        `the step yielding \`${yields}\` must run before \`delete\``,
      ).toBeLessThan(deleteAt);
    }
  });
});

describe("the policy the procedure is compared against", () => {
  it("quotes the published policy sentence for sentence, so the comparison is against the text", () => {
    // THE ASSERTION A POLICY EDIT FAILS. The procedure's whole conclusion is a disagreement with the
    // published wording, and a disagreement with a sentence that is no longer in the policy is not a
    // finding. This does not check the argument — only that the words being argued about are there.
    const page = policyProse();
    const passages = quotedPassages(document);

    expect(passages.length).toBeGreaterThanOrEqual(5);

    for (const passage of passages) {
      expect(page, `this passage is not in ${POLICY_PAGE}: ${passage}`).toContain(passage);
    }
  });
});

describe("the population the census derives", () => {
  it("gives the capture step one arm per prefix a deletion removes, and none for the rest", () => {
    // THE ASSERTION A NEW STORE FAILS, on the R2 side. A prefix the census marks reached and the
    // capture step does not walk is an object the procedure deletes the only index to; a prefix
    // marked unreached that the step walks anyway is the procedure deleting a tenant's files.
    const capture = stepNamed("capture-object-keys");

    expect(R2_PREFIXES.length).toBeGreaterThan(0);

    for (const entry of R2_PREFIXES) {
      expect(
        capture.body.includes(entry.prefix),
        `\`${entry.prefix}\` is marked reached by a deletion: ${entry.reachedByDeletion}, and the ` +
          "capture step says otherwise",
      ).toBe(entry.reachedByDeletion);
    }
  });

  it("gives the blocking step one row per foreign key that makes the deletion refuse", () => {
    // THE ASSERTION A NEW FOREIGN KEY FAILS, on the Postgres side. `blockers` is diagnostic — it
    // does not prevent the refusal, it names it before it happens — so a key missing from it is a
    // run that reaches `delete`, refuses, and reports a SQLSTATE where the operator needed a count.
    const blockers = stepNamed("blockers");
    const blocking = blockingForeignKeys();

    expect(blocking.length).toBeGreaterThan(0);

    for (const key of blocking) {
      expect(
        blockers.body,
        `\`${key.sourceTable}.${key.sourceColumns.join(", ")}\` blocks a deletion and is not counted`,
      ).toContain(`'${key.sourceTable}.${key.sourceColumns.join("+")}'`);
    }

    // And the other direction, so the step cannot quietly grow an arm for a key that does not block.
    const arms = blockers.body.match(/select '/g) ?? [];
    expect(arms.length).toBe(blocking.length);
  });
});

describe("the demonstration's cases", () => {
  it("skips a step that exists, so a case cannot demonstrate a removal it did not make", () => {
    // A misspelled skip is a case that runs the whole procedure and reports the result as the
    // failure demonstration. The run refuses that too; this is the same check before a database is
    // needed, because the mistake belongs to the list rather than to the run.
    const declared = new Set(steps.map((step) => step.name));

    expect(DEMONSTRATION_CASES.length).toBeGreaterThan(0);

    for (const spec of DEMONSTRATION_CASES) {
      for (const name of spec.skip) {
        expect(declared.has(name), `case \`${spec.label}\` skips \`${name}\``).toBe(true);
      }
    }
  });

  it("removes a step in at least one case, so the demonstration shows a failure and not only a pass", () => {
    // Rule 36 applied to a procedure: a step whose omission leaves no residue is either unnecessary
    // or its residue is undetectable. Both are findings, and neither can be reached by a case list
    // that never omits anything.
    expect(DEMONSTRATION_CASES.filter((spec) => spec.skip.length > 0).length).toBeGreaterThan(0);
  });

  it("runs at least one case whose deletion the schema refuses and one it completes", () => {
    // The two answers the graph can give, and the demonstration is only about the graph if it shows
    // both. A case list that had drifted to refusals alone would read as a procedure that never
    // works; one that had drifted to completions alone would read as a procedure that always does.
    const selections = DEMONSTRATION_CASES.map((spec) => spec.select);

    expect(selections).toContain("blocked");
    expect(selections).toContain("completable");
  });
});
