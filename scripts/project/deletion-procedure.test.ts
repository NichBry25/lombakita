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
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPANY } from "@/config/company";
import {
  R2_PREFIXES,
  blockingForeignKeys,
  cascadeClosure,
  detachingForeignKeys,
  schemaForeignKeys,
  survivingPersonalColumns,
} from "./deletion-census";
import {
  DEMONSTRATION_CASES,
  parseProcedure,
  PROCEDURE_PATH,
  type ProcedureStep,
} from "./run-deletion-procedure";

const POLICY_PAGE = "src/app/kebijakan-privasi/page.tsx";

/** The doc lane's own root, so the two read failures above can be told apart. */
const DOC_LANE = "docs";

/**
 * Read once, at module scope: every assertion below is about one document, and parsing it per test
 * would let the file hold two different procedures at once.
 *
 * The read can fail, and the two ways it fails are different documents' problems. `docs/` absent
 * means the doc lane did not check out — a token scoped to the wrong repository, or a checkout that
 * skipped the second clone. `docs/` present with this file missing means the lane is here and this
 * one document is not, which is what a doc-repository commit that was never pushed looks like. One
 * sentence for both sent the reader to the checkout when the answer was the file. This file refuses
 * at collection; `register-census.test.ts` measures the same lane and refuses at run time. Naming
 * the lane is the property both share.
 */
const readProcedure = (): string => {
  try {
    return readFileSync(PROCEDURE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    if (!existsSync(DOC_LANE)) {
      throw new Error(
        `the account-deletion procedure is not readable at ${PROCEDURE_PATH}: the doc lane ` +
          `(\`docs/\`, its own private repository under Rule 26) is not present in this checkout.`,
      );
    }

    throw new Error(
      `the account-deletion procedure is not readable at ${PROCEDURE_PATH}: the doc lane is ` +
        "present in this checkout and does not hold this file. It is tracked in the doc " +
        "repository, so this is a document that was never committed or pushed there — not a " +
        "checkout that is missing the lane.",
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
  it("parses into the seven steps it describes, in the order it describes them", () => {
    // The harness refuses an unknown fence and a duplicate name on the way through, so reaching this
    // assertion at all is the first result: the document is well formed against the grammar it
    // declares in its own fence table.
    expect(steps.map((step) => step.name)).toEqual([
      "preflight-owners",
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
 * Every refusal asserted below fires in `assertResetTargetIsDisposable` before it asks the server for
 * `current_database()`, so no run here needs a server and none can touch one.
 *
 * NO INLINE CREDENTIAL, and not merely because the scan would flag one. Both layers under test read
 * the host and nothing else, so a user and password here would be decoration that happens to carry
 * the exact shape `verify:secrets` exists to catch — and the right answer to a fixture matching that
 * rule is to stop writing the shape, not to allowlist a fingerprint and weaken the rule for the next
 * URL that matches it for real.
 */
const DEAD_LOOPBACK = "postgres://127.0.0.1:59432/lombakita_absent";

/** A host the guard must refuse outright, parseable and unreachable. */
const REMOTE_HOST = "postgres://db.invalid.example.com:5432/lombakita_absent";

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
 *
 * It returns the child whole, and `runRunner` below flattens it for the cases that only ask whether
 * a sentence was said. The cases that ask WHERE it was said, and what else came with it, keep the
 * streams and the status apart.
 */
const runRunnerResult = (environment: Record<string, string>) =>
  spawnSync(
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

/** The two streams as one string, for the assertions that only ask whether a sentence was said. */
const runRunner = (environment: Record<string, string>): string => {
  const result = runRunnerResult(environment);

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

/**
 * The sentence the environment layer produces, and the only thing that can produce it.
 *
 * The step's own report comes from `assertResetTargetIsDisposable` through
 * `connectToGuardedDatabase` (K2), and that guard now speaks in the verb its caller passes
 * (LAUNCH-D144) — this runner passes `delete`, so the layer says "refusing to delete" here rather
 * than "refusing to reset", which named an operation the operator had not asked for. Quoting the
 * RESOLVED value is still what makes this proof the gate ran: only the environment layer can produce
 * this sentence, and only with the value already resolved.
 */
const environmentRefusal = (resolved: string) =>
  `refusing to delete: APP_ENV resolves to "${resolved}"`;

/** The connection-host layer's sentence. Its layer name is what makes it distinguishable. */
const HOST_REFUSAL = "which is not loopback";

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

  // THE OPERATOR'S HALF OF A REFUSAL, which the merged output cannot answer: it says neither which
  // stream a sentence arrived on nor what came after it. What is asserted here is the shape of the
  // whole answer — the exit status, the stream the sentence is on, and the absence of a frame
  // marker under it.
  //
  // WHY THE STACK RULE HAS TO BE ASSERTED HERE AND NOT IN THE UNIT THAT BUILDS THE REFUSAL. Both
  // refusal types carry a message and both print it, so a case that only asks whether the sentence
  // appeared passes against either behaviour; the difference is entirely in what else is printed.
  // The third clause is the only one that moves, and it is the one an operator feels: a stack
  // between the sentence and the end of the output buries the sentence that says what was refused.
  it("refuses the production run with the sentence alone, no stack under it, and a non-zero exit", () => {
    const result = runRunnerResult({ APP_ENV: "production" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^refusing to delete: APP_ENV/);
    expect(
      result.stderr,
      "the refusal printed a stack under its sentence, so the operator reads frames where the refusal should be",
    ).not.toMatch(/^\s+at /m);
  }, 90_000);

  it("refuses staging and preview too, rather than only the name it was tested with", () => {
    for (const appEnv of ["staging", "preview"]) {
      expect(runRunner({ APP_ENV: appEnv })).toContain(environmentRefusal(appEnv));
    }
  }, 60_000);

  it("refuses a non-loopback host, naming the host it refused", () => {
    const output = runRunner({ DATABASE_URL: REMOTE_HOST, APP_ENV: "local" });

    expect(output).toContain(HOST_REFUSAL);
    expect(output).toContain("db.invalid.example.com");
  }, 60_000);

  // THE ORDER, pinned because consolidating two guard chains into one is exactly the change that
  // silently swaps it. This runner used to ask host-then-environment; `assertResetTargetIsDisposable`
  // asks environment-then-host. With BOTH layers objecting, only one refusal can be the one printed,
  // and it is the environment's. A future reordering of the shared guard fails here — which is the
  // discrimination the two chains lacked while they both existed and nobody compared them.
  it("asks the environment before the host, which is the shared guard's order", () => {
    const output = runRunner({ DATABASE_URL: REMOTE_HOST, APP_ENV: "production" });

    expect(output).toContain(environmentRefusal("production"));
    expect(
      output,
      "the connection-host layer answered first, so the two chains are in different orders again",
    ).not.toContain(HOST_REFUSAL);
  }, 60_000);

  // THE CONTROL, and the reason the three assertions above are about the guard rather than about the
  // script failing for any reason at all. A disposable environment on a loopback address must get
  // PAST both layers — if it did not, every assertion above would pass against a runner that refused
  // unconditionally, which is the same defect one level up.
  it("permits a disposable environment on a loopback address, so the refusals above are the guard", () => {
    const output = runRunner({ APP_ENV: "local" });

    // THE VERB, ASSERTED AS A CONTROL. Every refusal this runner prints says "refusing to delete";
    // a "refusing to reset" anywhere in its output is the shared guard having reverted to a
    // constant verb, which is the defect LAUNCH-D144 named (Rule 36's removal direction, run
    // against the parameter rather than against a call).
    expect(output).not.toContain("refusing to reset");
    expect(output).not.toContain(HOST_REFUSAL);
    // Nothing stands between the environment layer and the connection, so a run that cleared both
    // and then failed has demonstrably reached the end of the guard chain.
    expect(output.trim(), "the run produced no output at all").not.toBe("");
  }, 60_000);

  // WHAT IS NOT MEASURED HERE, stated rather than implied (Rule 32 permits a stated absence with a
  // reason). The identity layer — `select current_database()` answered by the server, checked by
  // `findDatabaseNameRefusal` — cannot be made to refuse without a reachable database carrying a
  // protected name, and this file is the one that runs without one. Making it REFUSE belongs with
  // the probes that create throwaway databases.
  //
  // THE PLACEMENT CLAIM, STATED AT THE STRENGTH THAT IS NOW TRUE. It used to be a compile error
  // here, because the helper was local to this file: `main` could not name a connection type without
  // calling the one function that performed the check. The helper is now
  // `connectToGuardedDatabase` in `scripts/lib/procedure-harness.ts`, shared with the provisioning
  // runner, so what this file can still guarantee is narrower and is asserted below: this file
  // constructs no connection of its own, so it has no socket that skipped the guard. That the guard
  // RUNS before the handle is returned is measured by execution in `procedure-harness.test.ts`, not
  // by a grep here.
  it("obtains its connection only from the helper that performed the check", () => {
    expect(source).toContain(
      'const sql = await connectToGuardedDatabase(url, { verb: "delete", appEnv, redisUrl: null });',
    );

    // ZERO construction sites, down from exactly one. The one that used to be here moved into the
    // helper with the check; any `postgres(` reappearing in this file would be a socket that never
    // asked the server anything.
    const constructions = source.match(/postgres\(/g) ?? [];
    expect(constructions).toHaveLength(0);
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

/**
 * The residue section, as the document states it: one row per surviving table, the columns on it, and
 * the group saying why the row is still there.
 *
 * Parsed rather than quoted so the comparison is against what a reader sees, not against a sentence
 * that happens to contain the right words. A table the census derives and the document omits is a
 * personal column the operator will not go looking for.
 */
type ResidueRow = { table: string; columns: string[]; why: string };

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

const residueRows = (markdown: string): ResidueRow[] => {
  const rows: ResidueRow[] = [];

  for (const line of markdown.split("\n")) {
    const cells = /^\| `([a-z_]+)` \| (.+?) \| (.+?) \|$/.exec(line);
    if (cells === null) continue;

    rows.push({ table: cells[1]!, columns: backticked(cells[2]!), why: cells[3]! });
  }

  return rows;
};

/** One `- **label (n):** \`a\`, \`b\`` group from the section, and the count it prints. */
type ResidueGroup = { label: string; declared: number; tables: string[] };

const residueGroups = (markdown: string): ResidueGroup[] => {
  const groups: ResidueGroup[] = [];

  for (const line of markdown.split("\n")) {
    const match = /^- \*\*(.+?) \((\d+)\):\*\* (.+)$/.exec(line);
    if (match === null) continue;

    groups.push({
      label: match[1]!,
      declared: Number(match[2]),
      tables: backticked(match[3]!),
    });
  }

  return groups;
};

describe("the residue the census derives", () => {
  // THE ASSERTION A COLUMN CHANGE FAILS. The section is the only place a reader of the procedure is
  // told which personal columns outlive a deletion — the enumeration artifact carries the same facts
  // in a different shape, and the procedure is what someone holding a live request reads. Deriving
  // both sides from the census is what makes the document's copy checkable: a column added to a
  // surviving table appears in `survivingPersonalColumns()` and this fails until the document lists
  // it, with the columns it actually has.
  it("lists every table that can leave a personal column behind, with those columns", () => {
    const derived = survivingPersonalColumns()
      .map((entry) => ({ table: entry.table, columns: [...entry.columns].sort() }))
      .sort((a, b) => a.table.localeCompare(b.table));

    expect(derived.length).toBeGreaterThan(0);

    const stated = residueRows(document)
      .map((row) => ({ table: row.table, columns: [...row.columns].sort() }))
      .sort((a, b) => a.table.localeCompare(b.table));

    expect(stated).toEqual(derived);
  });

  // THE THREE REASONS, each derived from the edge it names. Grouping by CASCADE REACH instead is the
  // mistake this test exists to catch: a table outside the closure reads as "never reached" while it
  // carries a `SET NULL` foreign key to `users`, or a NO ACTION edge that REFUSES the statement
  // outright. A table moved between groups by hand would still be present in the table above and
  // would still be wrong about why — which is the difference between a residue an operator can act
  // on and one they can only read.
  //
  // WHY THERE IS NO FOURTH GROUP. `rowsCanOutliveDeletion` is true of a closure table only through a
  // blocking or a detaching key, so a closure table the two branches below did not claim is not one
  // the statement can leave a row behind on. A group for that case is empty by construction, and an
  // empty group in a section an operator reads is a claim with nothing under it.
  //
  // FIRST MATCH WINS, in the order the section states. The order is load-bearing rather than
  // cosmetic: a blocking edge is checked before a detaching one, so a table carrying both reads as
  // the refusal it can cause rather than the detach it also permits.
  it("groups those tables by the edge that leaves the row standing", () => {
    const keys = schemaForeignKeys();
    const closure = new Set(cascadeClosure("users", keys));

    // THE POPULATION IS THE SECTION'S OWN, taken from the same call the table above is checked
    // against. Every table with a personal column is not it: `users`, `accounts` and `sessions`
    // carry personal columns and the statement deletes their rows outright, so a group saying the
    // deletion never reaches them would be false about exactly the tables it named. What the
    // section lists, and what these groups must partition, is the tables whose rows can still be
    // there when the statement finishes — `survivingPersonalColumns()`.
    const survivors = survivingPersonalColumns().map((entry) => entry.table);

    const sourcesOf = (foreignKeys: ReturnType<typeof blockingForeignKeys>): Set<string> =>
      new Set(foreignKeys.map((key) => key.sourceTable));

    const blocking = sourcesOf(blockingForeignKeys(keys, closure));
    const detaching = sourcesOf(detachingForeignKeys(keys, closure));

    const refuses = "Refuses the deletion while a row names the account";
    const detaches = "Survives, with the account's key set to null";
    const neverReached = "Never reached by the deletion";

    const groupOf = (table: string): string => {
      if (blocking.has(table)) return refuses;
      if (detaching.has(table)) return detaches;
      return neverReached;
    };

    const labels = [refuses, detaches, neverReached];
    const derived = labels.map((label) => survivors.filter((table) => groupOf(table) === label));

    const groups = residueGroups(document);

    expect(groups.map((group) => group.label)).toEqual(labels);

    // EVERY surviving table lands in exactly ONE of the three groups, checked BEFORE the group lists
    // are compared one at a time. The order is what makes these two assertions separate guards rather
    // than one: a table in NO group fails here, a table in the WRONG group fails below, and a table in
    // two groups fails on the count. The first of them is the load-bearing one — a survivor the
    // section lists and no group claims leaves the section reading as complete over a table it
    // silently dropped, and a reader holding a live request has nowhere to look for that table's
    // residue.
    const groupedTables = groups.flatMap((group) => group.tables);

    expect(
      [...groupedTables].sort(),
      "a surviving table is in none of the three groups the section names",
    ).toEqual([...survivors].sort());
    expect(
      groupedTables.length,
      "a table is listed under two groups, so its residue is reported twice",
    ).toBe(new Set(groupedTables).size);

    for (const [index, group] of groups.entries()) {
      const expected = [...(derived[index] ?? [])].sort();

      expect(
        [...group.tables].sort(),
        `the group \`${group.label}\` is not what the graph says`,
      ).toEqual(expected);
      // The count is printed so a reader can see the size at a glance; it is checked so it cannot
      // go stale while the list under it changes.
      expect(group.declared, `the group \`${group.label}\` miscounts itself`).toBe(expected.length);
    }

    // NAMED, so a table that lands in the wrong group fails under its own name rather than as a
    // diff between two sorted lists. Each of the first four carries a `SET NULL` foreign key to
    // `users`, which is what a reader of the residue section is looking for; `platform_ops_audit_logs`
    // carries the NO ACTION edge that refuses the whole statement.
    for (const [table, label] of [
      ["institution_invitations", detaches],
      ["institution_audit_logs", detaches],
      ["institution_verification_audit", detaches],
      ["institution_verification_submissions", detaches],
      ["platform_ops_audit_logs", refuses],
    ] as const) {
      expect(groupOf(table), `\`${table}\` is not in the group its edge puts it in`).toBe(label);
    }

    // The table's own third column has to say the same thing as the group it appears in. Without
    // this the two halves of the section can disagree — a row labelled "the deletion never reaches
    // it" sitting under a group that reaches it — and both halves would still match their own
    // derivation. That is the shape M2 found.
    const groupOfListed = new Map(
      groups.flatMap((group) => group.tables.map((t) => [t, group.label])),
    );

    for (const row of residueRows(document)) {
      expect(
        row.why,
        `the row for \`${row.table}\` disagrees with the group it is listed under`,
      ).toBe(groupOfListed.get(row.table));
    }
  });

  // THE LINK BETWEEN THE TWO TESTS ABOVE, which neither of them makes on its own. The table can
  // list a table that no group explains, and the groups can name a table the table omits, and both
  // assertions would still pass — the table is compared with the census and the groups are compared
  // with the graph, and the two comparisons never meet. What is asserted here is that the three
  // groups cover the residue table exactly, so there is no fourth kind of survivor left unwritten.
  // The census derives the same thing through `rowsCanOutliveDeletion`, and the oracle measured it
  // against a live database — it observed no closure row surviving with a live pointer to the
  // deleted account.
  it("leaves no surviving table outside the three groups the section names", () => {
    const listed = residueRows(document)
      .map((row) => row.table)
      .sort();
    const everyListing = residueGroups(document).flatMap((group) => group.tables);

    expect(
      [...everyListing].sort(),
      "a table the section lists is in none of the three groups",
    ).toEqual(listed);
    expect(
      everyListing.length,
      "a table is listed under two groups, so a reader finds it twice and trusts neither",
    ).toBe(new Set(everyListing).size);
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
