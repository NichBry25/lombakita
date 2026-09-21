// @vitest-environment node
//
// The operator-provisioning procedure document, and the residue an omitted step leaves.
//
// WHAT THE FIRST HALF IS FOR. The procedure is hand-written prose with fenced statements in it, and
// the harness executes whatever those statements say. So the failure mode is not a broken function —
// it is a document whose steps have drifted from the code its enumeration is derived from, or whose
// ordering is the reverse of the one the enrolment page forces. Each assertion below fails on a
// change to that code, and names the file rather than the shape it broke.
//
// WHAT THE SECOND HALF IS FOR, and what it is measured against. The claim is: a step omitted from
// this procedure leaves something a later reader can detect. The oracle is the application's own
// gate, `resolveMfaStatus` — not this file's arithmetic and not the document's `postcondition` step,
// because a run measured by the procedure it is measuring answers a different question. The subject
// under test is the PROCEDURE; the gate is the reader looking at what the procedure left behind.
//
// WHERE THAT INDEPENDENCE RUNS OUT, stated so the assertions below are not read as stronger than
// they are. `readProvisioningState` in the harness and the document's `postcondition` step are the
// SAME QUERY — same predicate, same columns — written twice by the same author from the same reading
// of the schema. They are independent for EXECUTION: the harness's answer does not require the
// document's step to have run, so an omitted postcondition cannot hide inside the measurement. They
// are not independent for DERIVATION: a shared misreading of what "provisioned" means would be
// invisible to both, and this file could not tell you. The gate is the part that is not a second copy
// of the author's arithmetic — it is application code with its own tests.
//
// WHAT THE ASSERTIONS ARE AIMED AT. An oracle that only catches an OMITTED step catches the easy
// failure. The mutations that matter are the ones where every step ran and the promote step did
// something the procedure does not say it does — a role change plus a suspension, or plus an MFA
// invalidation. Those pass an omission oracle, so each field the state carries is asserted to be at
// its untouched value rather than only its role.
//
// WHY THE FIXTURES ARE REAL ROWS. `runProcedure` executes the document's own SQL against a real
// connection, so a hand-built object could not be its input. The fixture accounts are inserted with
// raw SQL and removed in `afterAll`, which also asserts that none survived (Rule 35).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { resolveMfaStatus } from "@/server/auth/mfa/mfa-status";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import {
  DEMONSTRATION_CASES,
  parseProcedure,
  PROCEDURE_PATH,
  ProcedureRefusal,
  runProcedure,
  type ProcedureRun,
  type ProcedureStep,
  type ProvisioningState,
  type StepOutcome,
} from "./run-provisioning-procedure";

const ENROL_PAGE = "src/app/auth/mfa/enroll/page.tsx";

/**
 * Read once, at module scope: every assertion below is about one document, and parsing it per test
 * would let the file hold two different procedures at once.
 *
 * The read can fail. `docs/` is its own private repository (Rule 26) and is gitignored in the
 * product repo, so a checkout without the doc lane has no procedure at that path. It refuses with
 * that sentence rather than letting an ENOENT out of the parser, because the missing thing is the
 * lane, not the statement.
 */
const readProcedure = (): string => {
  try {
    return readFileSync(PROCEDURE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    throw new Error(
      `the operator-provisioning procedure is not readable at ${PROCEDURE_PATH}: the doc lane ` +
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

describe("the procedure document", () => {
  it("parses into the seven steps it describes, in the order it describes them", () => {
    // The harness refuses an unknown fence and a duplicate name on the way through, so reaching this
    // assertion at all is the first result: the document is well formed against the grammar it
    // declares in its own fence table.
    expect(steps.map((step) => step.name)).toEqual([
      "resolve",
      "preconditions",
      "promote",
      "verify-role",
      "enrol",
      "verify-factor",
      "postcondition",
    ]);
  });

  it("gives every statement the user id as a parameter", () => {
    // The harness hands `[userId]` to every block. A statement that does not filter on `$1` still
    // runs — Postgres accepts an unused parameter — so a `promote` that lost its `where` clause would
    // promote every candidate and recruiter on the database and report the row count as success.
    expect(sqlSteps.length).toBeGreaterThan(0);
    for (const step of sqlSteps) {
      expect(step.body, `step \`${step.name}\` does not filter on the user id`).toContain("$1");
    }
  });

  it("issues exactly one statement that writes, and it is the one step named for it", () => {
    // A second write is a second thing this document does that its enumeration does not account for,
    // and the STOP banner's promise — that the promotion is one `UPDATE` by one person — rests on
    // there being exactly one.
    const writes = sqlSteps
      .filter((step) => /^\s*(update|insert|delete|alter|drop|truncate)\b/im.test(step.body))
      .map((step) => step.name);

    expect(writes).toEqual(["promote"]);

    // The compare-and-set, written out: the statement names the state it is transitioning from, so
    // an account that changed between step 2's read and step 3's write matches zero rows instead of
    // being promoted on the strength of a stale read (Rule 25).
    expect(stepNamed("promote").body).toMatch(
      /and\s+role\s+in\s*\(\s*'candidate'\s*,\s*'recruiter'\s*\)/i,
    );
  });

  it("promotes before it enrols, which is the ordering the enrolment page forces", () => {
    // THE ASSERTION A REORDERED PROCEDURE FAILS, and the reason it is a derivation rather than a
    // preference: the page that mints the factor refuses to render for a self-service account. Reads
    // first, then the write; the write before the browser step; the read-back last.
    const order = steps.map((step) => step.name);

    expect(order.indexOf("promote")).toBeLessThan(order.indexOf("enrol"));
    expect(order.indexOf("enrol")).toBeLessThan(order.indexOf("verify-factor"));
    expect(order.indexOf("preconditions")).toBeLessThan(order.indexOf("promote"));
    expect(order.indexOf("promote")).toBeLessThan(order.indexOf("verify-role"));
    expect(order.at(-1)).toBe("postcondition");
  });

  it("states an ordering whose stated reason is still in the enrolment page", () => {
    // The document derives step 3's precedence from a line of code rather than choosing it. A
    // procedure whose justification has been deleted is a procedure asserting a preference, so this
    // checks the reason rather than only the order it produced.
    const page = readFileSync(ENROL_PAGE, "utf8");

    expect(page, `${ENROL_PAGE} no longer refuses a self-service account`).toMatch(
      /if \(isSelfServiceRole\(session\.user\.role\)\) \{\s*redirect\("\/"\);\s*\}/,
    );
  });

  it("names one step the harness cannot execute, and it is the browser one", () => {
    // The residue case depends on this step existing and on nothing executing it. A second `browser`
    // step is a second unreachable half of the procedure, and the document says there are exactly
    // two kinds of block rather than three.
    expect(steps.filter((step) => step.kind === "browser").map((step) => step.name)).toEqual([
      "enrol",
    ]);
  });

  it("states the acting database role as an unknown rather than leaving it unstated", () => {
    // Acceptance requires it, and the reason is specific: the procedure's write is issued by whatever
    // role the operator connects as, and nothing in the repository names that role for a deployed
    // environment. The instruction to read it live is the checkable part.
    expect(document).toContain("select current_database() as db, current_user as usr");
    expect(document).toContain("This is a named unknown, not an assumption.");
  });
});

describe("the fence grammar this parser reads", () => {
  // A BLOCK IT CANNOT READ IS THE FAILURE MODE, not an edge case. Before this refusal existed, three
  // malformed openers returned ZERO STEPS WITH NO ERROR — and one of them swallowed a valid step that
  // followed it, so the run reported "Steps executed: N of N declared" against a document whose step
  // had never been seen. The numbers agreed because both came from the same broken parse. Each input
  // below is a real Markdown code block that the narrow regex does not match.
  const refuses = (label: string, markdown: string): string => {
    try {
      parseProcedure(markdown);
    } catch (error) {
      expect(
        error,
        `${label}: refused with something other than a ProcedureRefusal`,
      ).toBeInstanceOf(ProcedureRefusal);
      return (error as Error).message;
    }
    throw new Error(`${label}: parsed without refusing`);
  };

  it("refuses a backtick fence whose info string is more than one word", () => {
    const message = refuses(
      "a two-word openers",
      "```sql copy\n-- step: promote\nselect 1;\n```\n",
    );
    expect(message).toContain(
      `line 1 opens a code block this harness cannot read: "\`\`\`sql copy"`,
    );
  });

  it("refuses an indented fence", () => {
    const message = refuses(
      "an indented fence",
      "-- prose\n  ```sql\n-- step: promote\nselect 1;\n  ```\n",
    );
    expect(message).toContain(`line 2 opens a code block this harness cannot read: "  \`\`\`sql"`);
  });

  it("refuses a tilde fence", () => {
    const message = refuses("a tilde fence", "~~~sql\n-- step: promote\nselect 1;\n~~~\n");
    expect(message).toContain(`line 1 opens a code block this harness cannot read: "~~~sql"`);
  });

  // THE DESCENT THAT MATTERS MOST, and the one the three cases above do not reach on their own. The
  // malformed opener is skipped, its CLOSING fence is then read as an opening bare fence — which is
  // illustrative and consumes everything to the next one — and the valid `verify-role` step between
  // them is absorbed into a block that is discarded. Measured against the pre-fix parser: zero steps,
  // no error, and the valid step gone. One refusal at the top has to happen before that descent can
  // start, which is why this asserts the refusal names the FIRST offending line.
  it("refuses a desynchronising opener before it can swallow the valid step that follows", () => {
    const message = refuses(
      "a desynchronising opener",
      "```sql copy\n-- step: promote\nselect 1;\n```\n\n```sql\n-- step: verify-role\nselect 2;\n```\n",
    );
    expect(message).toContain(
      `line 1 opens a code block this harness cannot read: "\`\`\`sql copy"`,
    );
  });

  // THE CONTROL. A parser that refused every fence would satisfy all four assertions above while
  // being unable to read the document this file is about — so the accepted form is asserted to parse.
  it("reads the accepted form, so the refusals above are the grammar and not a blanket refusal", () => {
    const steps = parseProcedure("```sql\n-- step: promote\nselect 1;\n```\n");
    expect(steps.map((step) => step.name)).toEqual(["promote"]);
  });
});

describe("the demonstration's cases", () => {
  it("omits only steps that exist, so a case cannot claim a removal it did not make", () => {
    // A misspelled omission is a case that runs the whole procedure and reports the result as the
    // residue demonstration. The run refuses that too; this is the same check before a database is
    // needed, because the mistake belongs to the list rather than to the run.
    const declared = new Set(steps.map((step) => step.name));

    expect(DEMONSTRATION_CASES.length).toBeGreaterThan(0);

    for (const spec of DEMONSTRATION_CASES) {
      for (const name of spec.omit) {
        expect(declared.has(name), `case \`${spec.label}\` omits \`${name}\``).toBe(true);
      }
    }
  });

  it("separates the two omissions whose residue is representable, and shows one complete run", () => {
    // Rule 36 applied to a procedure: an omission whose residue is undetectable is a finding, and no
    // case list that omits nothing can reach it. The list has to carry both a case that omits the
    // promotion and a case that runs it, or the two residues the document claims to distinguish are
    // not distinguished by anything that ran.
    const omissions = DEMONSTRATION_CASES.map((spec) => [...spec.omit].join(","));

    expect(omissions).toContain("promote");
    expect(omissions).toContain("");
  });
});

/**
 * A loopback address with nothing behind it.
 *
 * Loopback so the connection-host layer PASSES and the identity layer is the one a run reaches; dead
 * so that a test of the guard standing in front of a promotion cannot reach a database at all. Every
 * refusal asserted below is one of the guard's CONFIGURATION layers, which are asked before the
 * socket test, so no run here needs a server and none can touch one.
 *
 * NO INLINE CREDENTIAL, and not merely because the scan would flag one. The layers under test read
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
 */
const runRunner = (environment: Record<string, string>): string => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/project/run-provisioning-procedure.ts", "--select", "provisioned"],
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
  `refusing to reset: APP_ENV resolves to "${resolved}"`;

/** The connection-host layer's sentence. Its layer name is what makes it distinguishable. */
const HOST_REFUSAL = "which is not loopback";

describe("the guard in front of the promotion", () => {
  // THE ASSERTION A NARROWED GUARD FAILS. This runner promotes an account to `platform_ops` — a
  // stronger write than the reset's DROP — and it is guarded by the reset lane's own
  // `assertResetTargetIsDisposable` rather than by a second copy of its layers (Rule 37). The layer
  // functions are tested at their source; what is new here is the wiring that reaches them, and Rule
  // 32 says new wiring is not wired until a removed or moved call fails a test. Quoting the RESOLVED
  // value is what makes these proof the gate ran, rather than proof that the script failed for some
  // other reason.
  it("refuses a run in a process that declares production, by either variable", () => {
    const declarations: Record<string, string>[] = [
      { APP_ENV: "production" },
      { APP_ENV: "", NEXT_PUBLIC_APP_ENV: "production" },
      { APP_ENV: "   ", NEXT_PUBLIC_APP_ENV: "production" },
    ];

    for (const declaration of declarations) {
      const output = runRunner(declaration);

      expect(output, `permitted a run declaring ${JSON.stringify(declaration)}`).toContain(
        environmentRefusal("production"),
      );
    }
  }, 90_000);

  it("refuses a non-loopback host, naming the host it refused", () => {
    const output = runRunner({ DATABASE_URL: REMOTE_HOST, APP_ENV: "local" });

    expect(output).toContain(HOST_REFUSAL);
    expect(output).toContain("db.invalid.example.com");
  }, 60_000);

  // THE ORDER, pinned because consolidating two guard chains into one is exactly the change that
  // silently swaps it. This file used to ask host-then-environment; `assertResetTargetIsDisposable`
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

  // THE CONTROL, and the reason the assertions above are about the guard rather than about the
  // script failing for any reason at all. A disposable environment on a loopback address must get
  // PAST the configuration layers — if it did not, every assertion above would pass against a runner
  // that refused unconditionally, which is the same defect one level up.
  it("permits a disposable environment on a loopback address, so the refusals above are the guard", () => {
    const output = runRunner({ APP_ENV: "local" });

    expect(output).not.toContain("refusing to reset: APP_ENV resolves to");
    expect(output).not.toContain(HOST_REFUSAL);
    // Nothing stands between the configuration layers and the connection, so a run that cleared both
    // and then failed has demonstrably reached the end of the guard chain.
    expect(output.trim(), "the run produced no output at all").not.toBe("");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The residue, against a real database.
// ---------------------------------------------------------------------------------------------

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

/**
 * Every fixture this file creates carries this prefix, so teardown can find them without holding a
 * list that a mid-test failure would have prevented it from filling.
 *
 * Hyphens rather than the underscores the rest of this repository uses for synthetic ids, because
 * this string is the left-hand side of a `LIKE` and `_` is a wildcard there.
 */
const FIXTURE_PREFIX = "provisioning-fixture-";

let seq = 0;
const fixtureId = (): string => `${FIXTURE_PREFIX}${Date.now()}-${seq++}`;

const insertAccount = async (id: string, role: "candidate" | "platform_ops"): Promise<void> => {
  if (!client) throw new Error("no database");
  await client`
    insert into users (id, email, username, role, candidate_verified_at)
    values (${id}, ${`${id}@example.test`}, ${id}, ${role}, now())
  `;
};

/** A real `mfa_factors` row with `verified_at` set, which is the predicate the gate reads. */
const insertVerifiedFactor = async (userId: string): Promise<void> => {
  if (!client) throw new Error("no database");
  await client`
    insert into mfa_factors (user_id, encrypted_secret, secret_iv, secret_auth_tag, verified_at)
    values (${userId}, 'fixture', 'fixture', 'fixture', now())
  `;
};

afterAll(async () => {
  if (client) {
    await client`delete from mfa_factors where user_id like ${`${FIXTURE_PREFIX}%`}`;
    await client`delete from users where id like ${`${FIXTURE_PREFIX}%`}`;

    // Rule 35: a harness that creates data asserts what survived. A teardown that silently removed
    // nothing reads exactly like one that removed everything.
    const rows = await client<{ remaining: string }[]>`
      select count(*)::text as remaining from users where id like ${`${FIXTURE_PREFIX}%`}
    `;
    // A `select count(*)` always returns one row, so no row here means the read itself failed — which
    // must throw rather than be read as "nothing survived".
    const remaining = rows[0]?.remaining;
    if (remaining !== "0") {
      throw new Error(`${remaining ?? "no row returned"} fixture accounts survived teardown`);
    }
  }

  await client?.end();
});

const stateOf = (run: ProcedureRun): ProvisioningState => {
  if (run.state === null) {
    throw new Error("the run read no state, which means a step threw and aborted the transaction");
  }
  return run.state;
};

const outcomeNamed = (run: ProcedureRun, name: string): StepOutcome => {
  const outcome = run.steps.find((candidate) => candidate.name === name);
  if (outcome === undefined) throw new Error(`the run recorded no outcome for \`${name}\``);
  return outcome;
};

const promoted = (run: ProcedureRun): StepOutcome | undefined =>
  run.steps.find((candidate) => candidate.name === "promote");

/**
 * The gate's answer for a row, with no `mfaVerifiedAt` claim on the token — the state of every
 * session that existed before the account was enrolled. A token minted after enrolment would carry
 * the claim, and no such token exists at the moment a procedure finishes.
 */
const gate = (role: string, hasVerifiedFactor: boolean): string =>
  resolveMfaStatus({
    role,
    hasVerifiedFactor,
    mfaInvalidatedAt: null,
    tokenMfaVerifiedAtSeconds: undefined,
  });

describe.skipIf(skipWithoutDatabase)("the residue an omitted step leaves", () => {
  it("leaves a promoted account the gate holds at enrolment, and records the promotion", async () => {
    // THIS IS CASE B, run against a fixture rather than against the seed lane. The document's own
    // steps execute, `enrol` is named and not executed because it is a `browser` fence, and the
    // account is left holding the role with no second factor. The gate's answer is the residue.
    if (!client) throw new Error("no database");
    const account = fixtureId();
    await insertAccount(account, "candidate");

    const run = await runProcedure(client, steps, account);
    const state = stateOf(run);

    // The promotion actually landed, and the run says so as a number rather than as an assertion.
    // An account left unpromoted would make every claim below vacuously true.
    expect(outcomeNamed(run, "promote").affected).toBe(1);
    expect(run.rolledBack).toBe(true);

    expect(state.role).toBe("platform_ops");
    expect(state.hasVerifiedFactor).toBe(false);
    expect(state.isProvisioned).toBe(false);
    expect(state.mfaStatus).toBe("enrolment_required");

    // THE TWO ASSERTIONS AN OVERREACHING PROMOTE FAILS. Every assertion above this line passes when
    // the promote step sets the role AND suspends the account, or sets the role AND invalidates the
    // factor — `platform_ops`, no verified factor, `enrolment_required` are all still true, and the
    // omission oracle reports a clean run over an account the procedure has disabled. These are the
    // columns that make "the promote step did only what the document says" checkable rather than
    // assumed, and the procedure's own step 2 reads the row it is about to write, so a promotion that
    // changed either of these would be a change nothing in the document asked for.
    expect(
      state.suspendedAt,
      "the promote step suspended the account it was only meant to promote",
    ).toBeNull();
    expect(
      state.mfaInvalidatedAt,
      "the promote step invalidated a second factor it was never asked to touch",
    ).toBeNull();
  }, 30_000);

  it("leaves an account with the promotion omitted where it started, answering as one never touched", async () => {
    // THIS IS CASE C, and it is the same fixture as the case above with one step removed. Without it
    // the answer in the case above would not be distinguishable from an account that was always in
    // that state — which is exactly the question "is an omitted step detectable" being asked.
    if (!client) throw new Error("no database");
    const account = fixtureId();
    await insertAccount(account, "candidate");

    const withoutPromote = steps.filter((step) => step.name !== "promote");
    const run = await runProcedure(client, withoutPromote, account);
    const state = stateOf(run);

    expect(promoted(run), "`promote` was omitted and yet has an outcome").toBeUndefined();
    expect(state.role).toBe("candidate");
    expect(state.isProvisioned).toBe(false);
    expect(state.mfaStatus).toBe("not_applicable");
  }, 30_000);

  it("reads a completed provisioning as a third, different answer", async () => {
    // THIS IS CASE A. The completion predicate holds on this row, and the gate still answers
    // `challenge_required` rather than satisfied — because a token minted before enrolment carries no
    // claim. That third string is what makes the other two readable as residues rather than as the
    // only two states an account can be in.
    if (!client) throw new Error("no database");
    const account = fixtureId();
    await insertAccount(account, "platform_ops");
    await insertVerifiedFactor(account);

    const run = await runProcedure(client, steps, account);
    const state = stateOf(run);

    expect(state.role).toBe("platform_ops");
    expect(state.hasVerifiedFactor).toBe(true);
    expect(state.isProvisioned).toBe(true);
    expect(state.mfaStatus).toBe("challenge_required");
  }, 30_000);

  it("makes the three answers three different strings, which is the whole of the claim", async () => {
    // The detector for the property the cases rest on, stated so that this file goes RED FOR THE
    // REASON CLAIMED rather than merely red: the residue is detectable only because the gate
    // discriminates on the ROLE, not on the factor alone. Delete the operational-role branch
    // (`src/server/auth/mfa/mfa-status.ts:38-44`) and a promoted, unenrolled account answers exactly
    // what an untouched one answers, both omissions collapse into one, and this assertion fails
    // naming the branch — while every assertion above still passes, because they assert the strings
    // the branch currently produces.
    const answers = new Set([
      gate("platform_ops", true),
      gate("platform_ops", false),
      gate("candidate", false),
    ]);

    expect([...answers].sort()).toEqual([
      "challenge_required",
      "enrolment_required",
      "not_applicable",
    ]);
  });

  it("restores the role the account started with when the run throws", async () => {
    // The harness rolls back unconditionally, so a step that throws leaves nothing behind. Asserted
    // rather than assumed, because the guarantee this whole document gives — that a demonstration
    // leaves the database byte-identical — is the one that keeps a promotion out of a real account.
    if (!client) throw new Error("no database");
    const account = fixtureId();
    await insertAccount(account, "candidate");

    // The write is issued first and a later step then throws, so the rollback is the only thing
    // standing between the fixture and a real promotion. The steps are hand-built because this
    // measures the harness's transaction, not the document — and a document step that throws is not
    // something to add to the procedure in order to test it.
    const failing: ProcedureStep[] = [
      {
        kind: "sql",
        name: "promote",
        body: "update users set role = 'platform_ops' where id = $1",
        line: 1,
      },
      { kind: "sql", name: "boom", body: "select 1 / 0 as exploded", line: 2 },
    ];

    const run = await runProcedure(client, failing, account);

    expect(run.completedWithoutError).toBe(false);
    expect(run.state).toBeNull();

    const [row] = await client<{ role: string }[]>`
      select role::text as role from users where id = ${account}
    `;
    expect(row?.role, "the transaction committed the write it was rolled back for").toBe(
      "candidate",
    );
  }, 30_000);
});
