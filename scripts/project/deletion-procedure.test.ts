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

import { spawnSync } from "node:child_process";
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

/**
 * Read once, at module scope: every assertion below is about one document, and parsing it per test
 * would let the file hold two different procedures at once.
 *
 * The read can fail. `docs/` is its own private repository (Rule 26) and is gitignored in the
 * product repo, so a checkout without the doc lane has no procedure at that path. It refuses with
 * that sentence rather than letting an ENOENT out of the parser, because the missing thing is the
 * lane, not the statement. This file refuses at collection; `register-census.test.ts` measures the
 * same lane and refuses at run time. Naming the lane is the property both share.
 */
const readProcedure = (): string => {
  try {
    return readFileSync(PROCEDURE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    throw new Error(
      `the account-deletion procedure is not readable at ${PROCEDURE_PATH}: the doc lane ` +
        `(\`docs/\`, its own private repository under Rule 26) is not present in this checkout.`,
    );
  }
};

const document = readProcedure();
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

/**
 * A loopback address with nothing behind it.
 *
 * Loopback so the connection-host layer PASSES and the environment layer is the one a run reaches;
 * dead so that a test of the guard standing in front of a delete cannot reach a database at all.
 * Every refusal asserted below fires before `connectToDisposableDatabase` opens a socket, so no run
 * here needs a server and none can touch one.
 */
const DEAD_LOOPBACK = "postgres://probe:probe@127.0.0.1:59432/lombakita_absent";

/** A host the guard must refuse outright, parseable and unreachable. */
const REMOTE_HOST = "postgres://probe:probe@db.invalid.example.com:5432/lombakita_absent";

/**
 * One real run of the runner, under the environment it is being asked to refuse in.
 *
 * A CHILD PROCESS rather than a call. The guard sits inside `main`, which is not exported, and
 * exporting it in order to test it would prove the function rather than the wiring (Rule 33). What
 * is measured here is what an operator typing the command actually gets.
 *
 * `APP_ENV` and `NEXT_PUBLIC_APP_ENV` are passed as empty strings rather than omitted, because
 * `process.loadEnvFile` does not override a variable already present in the process: declaring them
 * empty is what stops a developer's own `.env.local` deciding the result of these assertions.
 */
const runRunner = (environment: Record<string, string>): string => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/project/run-deletion-procedure.ts", "--select", "completable"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: DEAD_LOOPBACK,
        APP_ENV: "",
        NEXT_PUBLIC_APP_ENV: "",
        ...environment,
      },
    },
  );

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

/** The sentence the environment layer produces, and the only thing that can produce it. */
const environmentRefusal = (resolved: string) =>
  `refusing to run: APP_ENV resolves to "${resolved}"`;

const HOST_REFUSAL = "runs only against a loopback database";

describe("the guard in front of the delete", () => {
  // THE ASSERTION A NARROWED GUARD FAILS. `reset-guard.ts` states the doctrine these three layers
  // come from: the server's own `current_database()` is authoritative, environment and connection
  // host read configuration and can be lied to, and the weaker two may only ADD a refusal. A
  // destructive statement standing behind the host alone is the shape DEC-0207 shipped.
  //
  // WHAT REPLACED A SOURCE GREP HERE, AND WHY IT HAD TO. Two assertions in this block used to read
  // the runner's own text and check that `findEnvironmentRefusal` and `findDatabaseNameRefusal`
  // appeared somewhere in it. Both were green through the entire window in which the environment
  // layer was INERT: the runner called `resolveAppEnvironment()` with no argument, and that function
  // reads neither APP_ENV nor NEXT_PUBLIC_APP_ENV — it consults NODE_ENV and VERCEL_ENV and
  // otherwise answers "local". A process whose only environment declaration said `production` was
  // therefore permitted, while the identifier the test searched for sat one line underneath. Rule 32
  // in its plainest form: presence is not enforcement. What follows runs the real script and reads
  // the refusal it really produces.
  const source = readFileSync("scripts/project/run-deletion-procedure.ts", "utf8");

  it("refuses a run in a process that declares production, by either variable", () => {
    // The three routes `reset-guard.ts` already carries for the reset, asserted here against the
    // deletion runner. The third is the one that motivated `declaredAppEnvironment`: an APP_ENV
    // set to the empty string must not shadow a NEXT_PUBLIC_APP_ENV that says production.
    const declarations: Record<string, string>[] = [
      { APP_ENV: "production" },
      { APP_ENV: "", NEXT_PUBLIC_APP_ENV: "production" },
      { APP_ENV: "   ", NEXT_PUBLIC_APP_ENV: "production" },
    ];

    for (const declaration of declarations) {
      const output = runRunner(declaration);

      // Quoting the RESOLVED value is what makes this proof the gate ran: only the environment
      // layer can produce this sentence, and only with production already resolved.
      expect(output, `permitted a run declaring ${JSON.stringify(declaration)}`).toContain(
        environmentRefusal("production"),
      );
    }
  }, 90_000);

  it("refuses staging and preview too, rather than only the name it was tested with", () => {
    for (const appEnv of ["staging", "preview"]) {
      expect(runRunner({ APP_ENV: appEnv })).toContain(environmentRefusal(appEnv));
    }
  }, 60_000);

  it("refuses a non-loopback host before it can resolve an environment", () => {
    const output = runRunner({ DATABASE_URL: REMOTE_HOST, APP_ENV: "local" });

    expect(output).toContain(HOST_REFUSAL);
    expect(output).toContain("db.invalid.example.com");
  }, 60_000);

  // THE CONTROL, and the reason the three assertions above are about the guard rather than about the
  // script failing for any reason at all. A disposable environment on a loopback address must get
  // PAST both layers — if it did not, every assertion above would pass against a runner that refused
  // unconditionally, which is the same defect one level up.
  it("permits a disposable environment on a loopback address, so the refusals above are the guard", () => {
    const output = runRunner({ APP_ENV: "local" });

    expect(output).not.toContain("refusing to run: APP_ENV resolves to");
    expect(output).not.toContain(HOST_REFUSAL);
    // Nothing stands between the environment layer and the connection, so a run that cleared both
    // and then failed has demonstrably reached the end of the guard chain.
    expect(output.trim(), "the run produced no output at all").not.toBe("");
  }, 60_000);

  // WHAT IS NOT MEASURED HERE, stated rather than implied (Rule 32 permits a stated absence with a
  // reason). The identity layer — `select current_database()` answered by the server, checked by
  // `findDatabaseNameRefusal` — cannot be made to refuse without a reachable database carrying a
  // protected name, and this file is the one that runs without one. Its PLACEMENT is guaranteed
  // structurally by the assertion below rather than by a grep: `main` has no way to obtain a handle
  // except from the helper that performs the check, so moving the check after the delete is a
  // compile error. Making it REFUSE belongs with the probes that create throwaway databases.
  it("returns the connection only from the helper that checked it", () => {
    // The ordering is a type constraint rather than a convention: `main` has no other way to obtain
    // a handle, so moving the check below the delete is a compile error rather than a probe.
    expect(source).toContain("const sql = await connectToDisposableDatabase(url);");

    // Exactly one construction site, and it is inside the helper that performs the check. A second
    // one would be a path to a connection that never asked the server anything.
    const constructions = source.match(/postgres\(url/g) ?? [];
    expect(constructions).toHaveLength(1);
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
