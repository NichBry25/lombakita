/**
 * Execute `docs/operations/account-deletion-procedure.md` against a local database.
 *
 * WHAT THIS IS. A reader for the procedure, not a second copy of it. Every statement that touches
 * data lives in the document; this file extracts the fenced blocks, runs the `sql` ones in document
 * order inside one transaction, and reports what each returned. Nothing here knows what the
 * procedure does — which is what makes the document the artifact and this the harness, and what
 * makes a step's absence in the document visible as a step that did not run.
 *
 * WHY A TRANSACTION. The delete and the cascade it fires are one atomic statement in Postgres, so a
 * blocking row produces a refusal with nothing written. Running the document's blocks in one
 * transaction reproduces that: a failure anywhere rolls the whole run back, and the account is
 * untouched rather than half-deleted.
 *
 * WHY THE TARGET IS DERIVED. The prompt this phase implements forbids a hand-listed population, and
 * it is right to: a population chosen by the person demonstrating the procedure is a population
 * chosen to succeed. `--select` asks the engine instead. `blocked` is the account the procedure's
 * own description names — a candidate holding a registration, a submission, a payment proof and
 * notifications. `completable` is an account with attributable rows whose deletion the engine
 * completes, decided by attempting the delete in a transaction that is rolled back.
 *
 * Usage:
 *   node --import tsx scripts/project/run-deletion-procedure.ts <userId>
 *   node --import tsx scripts/project/run-deletion-procedure.ts --select blocked|completable
 *   node --import tsx scripts/project/run-deletion-procedure.ts <userId> --skip blockers
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type postgres from "postgres";
import { loadEnvFile } from "@/server/scripts/env-file";
import { ResetRefused, declaredAppEnvironment } from "../reset/reset-guard";
import {
  ProcedureRefusal,
  connectToGuardedDatabase,
  parseProcedureSteps,
  type ProcedureStep as SharedProcedureStep,
} from "../lib/procedure-harness";
import { captureBaseline, objectKeySql, readIdentities } from "./deletion-residue";
import type { BaselineFile, ResidueBaseline } from "./deletion-residue";
import {
  competitionStatusEnum,
  type CompetitionStatus,
  type InstitutionMembershipRole,
  type InstitutionMembershipStatus,
} from "@/server/db/schema";

export const PROCEDURE_PATH = "docs/operations/account-deletion-procedure.md";
export const DEMONSTRATION_PATH = "docs/operations/account-deletion-demonstration.md";

/** What a block hands to the harness, beyond its own return value. */
export type YieldKind = "identity-literals" | "object-keys";

const YIELD_KINDS: readonly string[] = ["identity-literals", "object-keys"];

/** One step of the procedure, as this document declares it. */
export type ProcedureStep = Omit<SharedProcedureStep, "kind"> & {
  /** `sql` is executed; `r2` is named in the report and never executed. */
  kind: "sql" | "r2";
  yields: YieldKind | null;
};

export { ProcedureRefusal };

/**
 * The kinds this document's grammar carries that this runner does not execute.
 *
 * `browser` is the provisioning runner's: a step a person performs in a browser, which this harness
 * can neither perform nor verify. Refused rather than skipped — a document that grew one would
 * otherwise be read, reported as complete, and silently missing the step.
 */
const KINDS_THIS_RUNNER_DOES_NOT_EXECUTE = new Set(["browser"]);

/**
 * The procedure's steps, in document order.
 *
 * The grammar is `parseProcedureSteps`'s. What belongs here is the vocabulary and the one thing this
 * document declares that the other does not: `-- yields:`, on the second line of a `sql` block,
 * naming what the block hands back beyond its own return value.
 *
 * Refuses rather than skips, on two counts beyond the shared grammar's four: a `-- yields:` the
 * harness does not know, and a `-- yields:` on a block that cannot produce one. Each is a way for the
 * document to disagree with what actually runs, and a silent skip turns that disagreement into a
 * report of a step that was never performed.
 */
export const parseProcedure = (markdown: string): ProcedureStep[] =>
  parseProcedureSteps(markdown).map((step) => {
    if (KINDS_THIS_RUNNER_DOES_NOT_EXECUTE.has(step.kind)) {
      throw new ProcedureRefusal(
        `the \`${step.kind}\` block at line ${step.line} is a kind this runner does not execute. ` +
          `It carries \`${step.name}\` as a step it would report on while performing nothing`,
      );
    }

    const kind = step.kind as ProcedureStep["kind"];
    const declared = /^-- yields:\s*(\S+)\s*$/.exec(step.body.split("\n")[1] ?? "");
    let yields: YieldKind | null = null;

    if (declared !== null) {
      if (!YIELD_KINDS.includes(declared[1]!)) {
        throw new ProcedureRefusal(
          `step \`${step.name}\` declares \`-- yields: ${declared[1]}\`, which is not one of ` +
            YIELD_KINDS.join(", "),
        );
      }
      if (kind !== "sql") {
        throw new ProcedureRefusal(
          `step \`${step.name}\` is a \`${kind}\` block and cannot yield: this harness executes ` +
            "only `sql` blocks, so a yield declared here would never be produced",
        );
      }
      yields = declared[1] as YieldKind;
    }

    return { ...step, kind, yields };
  });

/** How a step's exception reads in the report, without the driver type in the way. */
export type DescribedError = { message: string; code: string | null; constraint: string | null };

/** What one executed step returned, as the report sees it. */
export type StepOutcome = {
  name: string;
  rows: Record<string, unknown>[];
  /** Present when the step threw. The transaction is aborted from this point. */
  error: DescribedError | null;
};

const describeError = (error: unknown): DescribedError => {
  const record = error as { message?: string; code?: string; constraint?: string };
  return {
    message: record.message ?? String(error),
    code: record.code ?? null,
    constraint: record.constraint ?? null,
  };
};

export type ProcedureRun = {
  steps: StepOutcome[];
  literals: string[];
  objectKeys: { prefix: string; objectKey: string }[];
  committed: boolean;
};

/**
 * The two membership tokens an ownerless institution turns on, and every competition status.
 *
 * Typed against the schema's own unions rather than written as bare strings, so a rename of either
 * token is a compile error here instead of a refusal that silently stops matching. The status list is
 * the enum's own `enumValues`, so its ORDER is the enum's order and a new status appears in the
 * refusal without anyone adding it.
 */
const INSTITUTION_OWNER_ROLE: InstitutionMembershipRole = "institution_owner";
const ACTIVE_MEMBERSHIP_STATUS: InstitutionMembershipStatus = "active";
const COMPETITION_STATUSES: readonly CompetitionStatus[] = competitionStatusEnum.enumValues;

/** An institution the subject's deletion would leave with no active owner, and what it holds. */
export type OwnerlessInstitution = {
  id: string;
  slug: string;
  competitionsByStatus: ReadonlyMap<CompetitionStatus, number>;
};

/**
 * Every institution this account is the LAST active owner of, with its competitions counted.
 *
 * ASKED OF THE MEMBERSHIP ROWS, not of `institutions.owner_user_id` or any other denormalisation —
 * there is none, and the membership table is the only place an owner is recorded.
 *
 * The `not exists` arm is the last-owner test and it excludes the subject by id, because the
 * subject's own memberships are the ones the deletion removes. A membership that is `invited`,
 * `inactive` or `revoked` is not an owner for this purpose: after the deletion nobody could sign in
 * and act as one, and an institution nobody can administer is the state this refuses to create.
 */
export const institutionsLeftWithoutAnOwner = async (
  sql: postgres.Sql,
  userId: string,
): Promise<OwnerlessInstitution[]> => {
  const rows = await sql<{ id: string; slug: string }[]>`
    select i.id, i.slug
    from institutions i
    where exists (
        select 1 from institution_memberships mine
         where mine.institution_id = i.id
           and mine.user_id = ${userId}
           and mine.membership_role = ${INSTITUTION_OWNER_ROLE}
           and mine.status = ${ACTIVE_MEMBERSHIP_STATUS}
      )
      and not exists (
        select 1 from institution_memberships other
         where other.institution_id = i.id
           and other.membership_role = ${INSTITUTION_OWNER_ROLE}
           and other.status = ${ACTIVE_MEMBERSHIP_STATUS}
           and other.user_id <> ${userId}
      )
    order by i.slug, i.id
  `;

  const institutions: OwnerlessInstitution[] = [];
  for (const row of rows) {
    const counted = await sql<{ status: CompetitionStatus; n: number }[]>`
      select c.status, count(*)::int as n
      from competitions c
      where c.institution_id = ${row.id}
      group by c.status
    `;
    institutions.push({
      id: row.id,
      slug: row.slug,
      competitionsByStatus: new Map(counted.map((entry) => [entry.status, entry.n])),
    });
  }

  return institutions;
};

/**
 * Refuses before the first write when the deletion would leave an institution with no active owner.
 *
 * THE ONE THING THE FOREIGN KEY CANNOT SEE. Every other blocker this procedure predicts is a row
 * that points at the account and would be orphaned; this one is an absence — the membership that
 * goes away with the account is what made the institution administrable, and nothing in the schema
 * requires an institution to keep one. Postgres deletes the account happily; the institution is left
 * with no one who can act for it, which is a state no later step in this procedure repairs.
 *
 * THE COUNTS ARE DIAGNOSTIC, not a second condition. They say what is at stake — how many
 * competitions would be left unadministrable — so the operator can decide whether to appoint a
 * second owner or delete the competitions first. Nothing here is written: the caller is refused.
 */
export const assertNoInstitutionIsLeftWithoutAnOwner = async (
  sql: postgres.Sql,
  userId: string,
): Promise<void> => {
  const institutions = await institutionsLeftWithoutAnOwner(sql, userId);
  if (institutions.length === 0) {
    return;
  }

  const lines = institutions.map((institution) => {
    const counts = COMPETITION_STATUSES.map(
      (status) => `${status}=${institution.competitionsByStatus.get(status) ?? 0}`,
    ).join(" ");

    return `${institution.slug} (${institution.id}): ${counts}`;
  });

  throw new ProcedureRefusal(
    `subject is the last active owner of ${institutions.length} institution(s)\n${lines.join("\n")}`,
  );
};

/**
 * Run the `sql` steps in order, in one transaction.
 *
 * The transaction is opened and closed explicitly rather than through a callback so that a failure
 * partway leaves the outcomes collected up to that point readable — a report that ends at the
 * failing step is the thing an operator needs, and a callback-shaped transaction would discard it
 * along with the rollback.
 */
export const runProcedure = async (
  sql: postgres.Sql,
  steps: readonly ProcedureStep[],
  userId: string,
): Promise<ProcedureRun> => {
  const run: ProcedureRun = { steps: [], literals: [], objectKeys: [], committed: false };

  // BEFORE `begin`, so a refusal opens no transaction at all rather than opening one to roll back.
  // The refusal is the whole of what happened: nothing was read, nothing was written, and the
  // caller's report says so rather than reporting a rollback of work that never started.
  await assertNoInstitutionIsLeftWithoutAnOwner(sql, userId);

  await sql.unsafe("begin");
  try {
    for (const step of steps) {
      if (step.kind !== "sql") {
        run.steps.push({ name: step.name, rows: [], error: null });
        continue;
      }

      try {
        const rows: Record<string, unknown>[] = await sql.unsafe(step.body, [userId]);
        run.steps.push({ name: step.name, rows, error: null });

        if (step.yields === "identity-literals") {
          for (const row of rows) {
            for (const value of Object.values(row)) {
              if (typeof value === "string" && value.length > 0) run.literals.push(value);
            }
          }
          run.literals = [...new Set(run.literals)];
        }

        if (step.yields === "object-keys") {
          for (const row of rows) {
            const prefix = row.prefix;
            const key = row.object_key;
            if (typeof prefix === "string" && typeof key === "string" && key.length > 0) {
              run.objectKeys.push({ prefix, objectKey: key });
            }
          }
        }
      } catch (error) {
        run.steps.push({ name: step.name, rows: [], error: describeError(error) });
        break;
      }
    }

    if (run.steps.some((step) => step.error !== null)) {
      await sql.unsafe("rollback");
      return run;
    }

    await sql.unsafe("commit");
    run.committed = true;
    return run;
  } catch (error) {
    await sql.unsafe("rollback").catch(() => undefined);
    throw error;
  }
};

/**
 * Whether the engine will complete a deletion of this account, asked by attempting it.
 *
 * The deletion is performed and rolled back rather than predicted from a list of blocking columns.
 * The list exists — `blockingForeignKeys()` derives it — but a prediction is a claim about the
 * graph, and the graph is what this phase spent its time discovering it could be wrong about. The
 * rollback is the post-condition: the caller asserts the row is still there afterwards.
 */
export const deletionWouldComplete = async (
  sql: postgres.Sql,
  userId: string,
): Promise<{ completes: boolean; code: string | null; constraint: string | null }> => {
  await sql.unsafe("begin");
  try {
    await sql.unsafe("delete from users where id = $1", [userId]);
    await sql.unsafe("rollback");
    return { completes: true, code: null, constraint: null };
  } catch (error) {
    await sql.unsafe("rollback");
    const described = describeError(error);
    return { completes: false, code: described.code, constraint: described.constraint };
  }
};

/** The two derived populations, and how many accounts each matched. */
type Selection = {
  userId: string;
  criterion: string;
  matched: number;
};

/** One execution of the procedure, with everything the report has to say about it. */
type CaseRun = {
  label: string;
  purpose: string;
  selection: Selection;
  declared: readonly ProcedureStep[];
  steps: readonly ProcedureStep[];
  skipped: readonly string[];
  run: ProcedureRun;
  /**
   * The pre-flight refusal, when there was one, and `null` when the procedure ran.
   *
   * A separate field rather than a step outcome, because no step produced it: the refusal happens
   * before the transaction opens, so a case carrying one has a run with no steps at all.
   */
  refusal: string | null;
  /** Object keys the foreign-key graph says this account holds, counted without the procedure. */
  expectedKeys: { prefix: string; column: string; n: number }[];
};

/**
 * The cases the demonstration runs, and why each one exists.
 *
 * These are cases, not a population: which ACCOUNT each one runs against is derived at run time by
 * `selectTarget`. The list is fixed because a demonstration is a chosen set of situations; the
 * subject of each is not, because a subject chosen to succeed demonstrates nothing.
 */
export const DEMONSTRATION_CASES: readonly {
  label: string;
  purpose: string;
  select: string;
  skip: readonly string[];
}[] = [
  {
    label: "Case A — the account the procedure's own description names",
    purpose:
      "A candidate holding a registration, a submission, a payment proof and notifications. The " +
      "account a deletion request is most likely to arrive for, and the one the graph refuses.",
    select: "blocked",
    skip: [],
  },
  {
    label: "Case B — an account the schema completes",
    purpose:
      "An account with attributable rows whose deletion the engine carries out. This is the run " +
      "the independent verifier checks afterwards.",
    select: "completable",
    skip: [],
  },
  {
    label: "Case C — case A's subject, with the gate removed",
    purpose:
      "The same account as case A, with `blockers` skipped. The account survives case A, so the " +
      "two cases really do share a subject. If the refusal happens anyway, the gate did not cause " +
      "it — the foreign key did — and the step is diagnostic, not protective.",
    select: "blocked",
    skip: ["blockers"],
  },
  {
    label: "Case D — an account holding objects, with the object-key capture removed",
    purpose:
      "`capture-object-keys` is skipped. The keys the graph says exist are counted independently " +
      "before the run and compared with what the run captured, so the subject has to be an account " +
      "that holds one — otherwise the omission has nothing to leave behind and the case reports a " +
      "clean result it did not earn.",
    select: "completable-with-objects",
    skip: ["capture-object-keys"],
  },
  {
    label: "Case E — an account holding identity strings, with the identity capture removed",
    purpose:
      "`capture-identities` is skipped. The residue this looks for is in the run's own record — the " +
      "literals it reports — and the database is unchanged either way, because the independent " +
      "verifier takes its literals from its own baseline. An account with nothing to read would " +
      "make that indistinguishable from a step that worked.",
    select: "completable-with-identities",
    skip: ["capture-identities"],
  },
];

/** Render one case, as a section of the document. */
const renderCase = (entry: CaseRun): string[] => {
  const { run, selection } = entry;
  const lines: string[] = [
    `## ${entry.label}`,
    "",
    `Why this case: ${entry.purpose}`,
    "",
    `Selected by: **${selection.criterion}**.`,
    `Accounts matching that criterion: **${selection.matched}**.`,
    `Chosen account: \`${selection.userId}\`.`,
    `Steps executed: **${entry.steps.length}** of **${entry.declared.length}** declared.`,
    entry.skipped.length === 0
      ? "Steps skipped: **none**."
      : `Steps skipped: **${entry.skipped.join(", ")}**.`,
    "",
    "| step | kind | rows | outcome |",
    "| --- | --- | --- | --- |",
  ];

  for (const step of entry.steps) {
    const outcome = run.steps.find((candidate) => candidate.name === step.name);
    if (outcome === undefined) {
      lines.push(`| \`${step.name}\` | ${step.kind} | — | not reached |`);
    } else if (outcome.error !== null) {
      const code = outcome.error.code === null ? "" : ` \`${outcome.error.code}\``;
      lines.push(`| \`${step.name}\` | ${step.kind} | — | refused:${code} |`);
    } else if (step.kind === "sql") {
      lines.push(`| \`${step.name}\` | ${step.kind} | ${outcome.rows.length} | ran |`);
    } else {
      lines.push(`| \`${step.name}\` | ${step.kind} | — | named, not executed |`);
    }
  }
  lines.push("");

  for (const step of run.steps) {
    if (step.error === null) continue;
    lines.push(`### \`${step.name}\` refused`, "", "```", step.error.message, "```", "");
    if (step.error.code !== null) {
      lines.push(`SQLSTATE \`${step.error.code}\`.`);
      if (step.error.constraint !== null) lines.push(`Constraint \`${step.error.constraint}\`.`);
      lines.push("");
    }
  }

  const expectedTotal = entry.expectedKeys.reduce((total, key) => total + key.n, 0);
  lines.push(
    "### What the run captured",
    "",
    `Identity literals: **${run.literals.length}**.`,
    `Object keys: **${run.objectKeys.length}**.`,
    "",
  );

  if (run.objectKeys.length > 0) {
    const byPrefix = new Map<string, number>();
    for (const key of run.objectKeys) {
      byPrefix.set(key.prefix, (byPrefix.get(key.prefix) ?? 0) + 1);
    }
    lines.push("| prefix | captured |");
    lines.push("| --- | --- |");
    for (const [prefix, count] of byPrefix) lines.push(`| \`${prefix}\` | ${count} |`);
    lines.push("");
  }

  lines.push(
    "### The object keys the graph says this account holds",
    "",
    "Counted from the foreign-key walk and the census's declared key columns, before the run and",
    "independently of it. This is the figure the capture step above is held against.",
    "",
    `Total: **${expectedTotal}**.`,
    "",
  );

  if (entry.expectedKeys.length > 0) {
    lines.push("| prefix | key column | rows holding one |");
    lines.push("| --- | --- | --- |");
    for (const key of entry.expectedKeys) {
      lines.push(`| \`${key.prefix}\` | \`${key.column}\` | ${key.n} |`);
    }
    lines.push("");
  }

  if (entry.refusal !== null) {
    lines.push(
      "### The outcome",
      "",
      "**Refused before the first write.** No transaction was opened, so there is no rollback to",
      "report: the procedure's own pre-flight found an institution this deletion would leave with",
      "no active owner, and stopped. Nothing was read and nothing was written.",
      "",
      "```",
      entry.refusal,
      "```",
      "",
    );

    return lines;
  }

  if (run.committed) {
    lines.push(
      "### The outcome",
      "",
      "**The transaction committed.** The account was removed and its cascade ran.",
      "",
      `${run.literals.length} identity literal(s) and ${run.objectKeys.length} object key(s) were read`,
      `before the delete, against ${expectedTotal} the graph says exist. Those keys are the ones the`,
      "R2 removal step would act on, and that step was **named and not executed**.",
      "",
    );
  } else {
    lines.push(
      "### The outcome",
      "",
      "**The transaction rolled back. Nothing was written.**",
      "",
      "The refusal is atomic, so this is not a partially deleted account — the account is exactly as",
      "it was, and so is everything the cascade would have reached. What the procedure could not",
      "deliver is the whole of it.",
      "",
    );
  }

  return lines;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const skip = new Set<string>();
  let select: string | null = null;
  let explicitUserId: string | null = null;
  let demonstrate = false;
  let out: string | null = null;
  let baselineOut: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--skip") {
      const name = argv[index + 1];
      if (name === undefined) throw new ProcedureRefusal("--skip needs a step name");
      skip.add(name);
      index += 1;
    } else if (argument === "--select" || argument === "--out" || argument === "--baseline-out") {
      const value = argv[index + 1];
      if (value === undefined) throw new ProcedureRefusal(`${argument} needs a value`);
      if (argument === "--select") select = value;
      if (argument === "--out") out = value;
      if (argument === "--baseline-out") baselineOut = value;
      index += 1;
    } else if (argument === "--demonstrate") {
      demonstrate = true;
    } else if (argument.startsWith("--")) {
      throw new ProcedureRefusal(`unknown flag ${argument}`);
    } else {
      explicitUserId = argument;
    }
  }

  const { loadedFrom } = loadEnvFile({});
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new ProcedureRefusal(`DATABASE_URL is not set and no env file was found (${loadedFrom})`);
  }
  // The three-layer disposability guard is `assertResetTargetIsDisposable`, reached through
  // `connectToGuardedDatabase` below — the reset lane's own, not a second copy of its layers
  // (Rule 37). This file used to compose its own, which had drifted in two ways nothing here could
  // see: it asked the connection host BEFORE the environment, and it read only
  // `current_database()` without `current_user`.
  //
  // `declaredAppEnvironment`, never `resolveAppEnvironment` directly: the latter reads only its
  // argument, NODE_ENV and VERCEL_ENV, so calling it bare answers "local" in a shell that has
  // declared production and leaves the environment layer inert.
  const appEnv = declaredAppEnvironment();

  const document = readFileSync(resolve(process.cwd(), PROCEDURE_PATH), "utf8");
  const declared = parseProcedure(document);
  const known = new Set(declared.map((step) => step.name));

  for (const name of skip) {
    if (!known.has(name)) {
      throw new ProcedureRefusal(
        `--skip ${name} names no step in ${PROCEDURE_PATH}; the steps are ${[...known].join(", ")}`,
      );
    }
  }

  const sql = await connectToGuardedDatabase(url, { verb: "delete", appEnv, redisUrl: null });

  try {
    if (demonstrate) {
      if (select !== null || explicitUserId !== null || skip.size > 0) {
        throw new ProcedureRefusal(
          "--demonstrate runs the fixed case list and takes no --select, user id or --skip",
        );
      }
      await demonstrateAll(sql, declared, out ?? DEMONSTRATION_PATH, baselineOut);
      return;
    }

    let selection: Selection;
    if (select !== null) {
      selection = await selectTarget(sql, select);
    } else if (explicitUserId !== null) {
      selection = { userId: explicitUserId, criterion: "named on the command line", matched: 1 };
    } else {
      throw new ProcedureRefusal("give a user id, --select blocked|completable, or --demonstrate");
    }

    const steps = declared.filter((step) => !skip.has(step.name));
    const expectedKeys = await countObjectKeys(sql, selection.userId);
    const { run, refusal } = await runOrRefuse(sql, steps, selection.userId);

    const text = renderCase({
      label: "The procedure, executed",
      purpose: "One run of the documented procedure against a derived target.",
      selection,
      declared,
      steps,
      skipped: [...skip],
      run,
      refusal,
      expectedKeys,
    }).join("\n");

    if (out === null) {
      console.log(text);
      return;
    }
    writeFileSync(resolve(process.cwd(), out), `${text}\n`, "utf8");
    console.log(`wrote ${out}`);
  } finally {
    await sql.end();
  }
};

/** The object keys the graph says this account holds, counted without the procedure's own query. */
const countObjectKeys = async (
  sql: postgres.Sql,
  userId: string,
): Promise<{ prefix: string; column: string; n: number }[]> => {
  const counted: { prefix: string; column: string; n: number }[] = [];
  for (const entry of objectKeySql()) {
    const [row] = await sql.unsafe<{ n: number }[]>(entry.sql, [userId]);
    if (row!.n > 0) counted.push({ prefix: entry.prefix, column: entry.column, n: row!.n });
  }
  return counted;
};

/**
 * Run the procedure, or hand back the pre-flight refusal as a value instead of an exception.
 *
 * The demonstration has to RECORD a refusal rather than stop at one: a case whose whole point is
 * that the deletion was refused is a case that has to appear in the document, and an exception
 * escaping `demonstrateAll` would leave every case after it unwritten. The CLI path does the
 * opposite and lets it throw, because a refusal there is the run's outcome and the final catch is
 * what an operator reads.
 */
const runOrRefuse = async (
  sql: postgres.Sql,
  steps: readonly ProcedureStep[],
  userId: string,
): Promise<{ run: ProcedureRun; refusal: string | null }> => {
  try {
    return { run: await runProcedure(sql, steps, userId), refusal: null };
  } catch (error) {
    if (!(error instanceof ProcedureRefusal)) throw error;

    return {
      run: { steps: [], literals: [], objectKeys: [], committed: false },
      refusal: error.message,
    };
  }
};

/** Run every case in `DEMONSTRATION_CASES`, in order, and write the record of all of them to one document. */
const demonstrateAll = async (
  sql: postgres.Sql,
  declared: readonly ProcedureStep[],
  out: string,
  baselineOut: string | null,
): Promise<void> => {
  const known = new Set(declared.map((step) => step.name));
  const cases: CaseRun[] = [];
  const baselines: { label: string; baseline: ResidueBaseline }[] = [];

  for (const spec of DEMONSTRATION_CASES) {
    for (const name of spec.skip) {
      if (!known.has(name)) {
        throw new ProcedureRefusal(`case \`${spec.label}\` skips \`${name}\`, which is not a step`);
      }
    }

    const selection = await selectTarget(sql, spec.select);
    const steps = declared.filter((step) => !spec.skip.includes(step.name));

    // Captured for EVERY case, including the ones expected to refuse. A baseline for a refusal is
    // the evidence that the refusal changed nothing, which is a claim the run's own report cannot
    // make about itself.
    baselines.push({
      label: spec.label,
      baseline: await captureBaseline(sql, selection.userId),
    });

    const expectedKeys = await countObjectKeys(sql, selection.userId);
    const { run, refusal } = await runOrRefuse(sql, steps, selection.userId);

    cases.push({
      label: spec.label,
      purpose: spec.purpose,
      selection,
      declared,
      steps,
      skipped: spec.skip,
      run,
      refusal,
      expectedKeys,
    });
  }

  const lines: string[] = [
    "# Account deletion — the procedure, executed",
    "",
    "**This file is generated. Do not edit it.**",
    "",
    `    node --import tsx scripts/project/run-deletion-procedure.ts --demonstrate`,
    "",
    `Every line below is written by \`scripts/project/run-deletion-procedure.ts\`, executing`,
    `\`${PROCEDURE_PATH}\` against the database the configuration names. The procedure is`,
    "hand-written; this is the record of running it, and nothing here was typed in by hand.",
    "",
    "The check on what a completed deletion left behind is a different instrument and a different",
    "file: `docs/operations/account-deletion-residue.md`, produced by",
    "`scripts/project/deletion-residue.ts` from a baseline that instrument captured for itself.",
    "",
    "**Nothing here ran against staging or production.** The harness refuses any `DATABASE_URL`",
    "that is not a loopback host. The one step whose credential is not the local database — the R2",
    "object removal — was named and not executed, and no object was removed by this phase.",
    "",
    "## The cases",
    "",
    "| case | the question it answers |",
    "| --- | --- |",
    ...DEMONSTRATION_CASES.map((spec) => `| ${spec.label} | ${spec.purpose} |`),
    "",
  ];

  for (const entry of cases) lines.push(...renderCase(entry));

  lines.push(
    "## What the cases together say",
    "",
    `Cases run: **${cases.length}**. Committed: **${cases.filter((entry) => entry.run.committed).length}**.`,
    `Refused by the schema: **${cases.filter((entry) => entry.refusal === null && !entry.run.committed).length}**.`,
    `Refused before the first write: **${cases.filter((entry) => entry.refusal !== null).length}**.`,
    "",
    "## What a zero in the residue file means",
    "",
    "Two separately filed findings compose, and neither is visible from inside the other.",
    "",
    "- **LAUNCH-D100 is a store the enumeration cannot see.** The census decides whether a table",
    "  holds user data by the foreign keys that reach it, and `institutions` declares no FK to",
    "  `users` at all — so a table nothing points at is ruled `holds-no-user-data`.",
    "- **LAUNCH-D101 is a form the verifier cannot match.** The value sweep's identity set is four",
    "  whole stored values, so a residue naming the person in any other string reports as zero.",
    "",
    'Together, **"zero residue" currently means "zero residue of four exact strings, in the stores',
    'the FK graph knows about."** That is the sentence to hold in mind when reading',
    "`docs/operations/account-deletion-residue.md`: a zero there is a statement about four literals",
    "and about the graph, not a statement that nothing about the person remains.",
    "",
  );

  writeFileSync(resolve(process.cwd(), out), `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${out}`);

  if (baselineOut !== null) {
    const file: BaselineFile = { generatedAt: new Date().toISOString(), cases: baselines };
    writeFileSync(
      resolve(process.cwd(), baselineOut),
      `${JSON.stringify(file, null, 2)}\n`,
      "utf8",
    );
    console.log(`wrote ${baselineOut}`);
  }
};

/**
 * Every account whose deletion the engine completes, lowest id first.
 *
 * "Completes" is asked of the engine — a `delete from users` attempted inside a transaction that is
 * always rolled back — rather than predicted from the blocking-column list. A prediction would be a
 * second copy of the census's answer, and the two drifting apart is exactly what this phase is
 * about.
 */
const deletableAccounts = async (sql: postgres.Sql): Promise<string[]> => {
  const candidates = await sql<{ id: string }[]>`
    select u.id
    from users u
    where exists (select 1 from competition_registrations r where r.student_id = u.id)
       or exists (select 1 from user_profiles p where p.user_id = u.id)
       or exists (select 1 from institution_memberships m where m.user_id = u.id)
    order by u.id
  `;

  const deletable: string[] = [];
  for (const candidate of candidates) {
    const attempt = await deletionWouldComplete(sql, candidate.id);
    if (attempt.completes) deletable.push(candidate.id);
  }

  return deletable;
};

/** Ask the database which account the criterion names. */
const selectTarget = async (sql: postgres.Sql, which: string): Promise<Selection> => {
  if (which === "blocked") {
    // The population the procedure's own description names: a candidate holding a registration, a
    // submission, a payment proof and notifications. Every clause is counted rather than assumed.
    const rows = await sql<
      {
        id: string;
        registrations: number;
        submissions: number;
        notifications: number;
        proofs: number;
      }[]
    >`
      select
        u.id,
        (select count(*)::int from competition_registrations r where r.student_id = u.id) as registrations,
        (select count(*)::int from competition_submissions s
           join competition_registrations r on r.id = s.registration_id
          where r.student_id = u.id) as submissions,
        (select count(*)::int from notifications n where n.user_id = u.id) as notifications,
        (select count(*)::int from finance_manual_payment_proofs p
          where p.submitted_by_user_id = u.id) as proofs
      from users u
      where u.role = 'candidate'
      order by u.id
    `;

    const matching = rows.filter(
      (row) =>
        row.registrations > 0 && row.submissions > 0 && row.notifications > 0 && row.proofs > 0,
    );

    if (matching.length === 0) {
      throw new ProcedureRefusal(
        "no candidate holds a registration, a submission, a payment proof and a notification at " +
          "once, so the account this demonstration is described against does not exist here",
      );
    }

    return {
      userId: matching[0]!.id,
      criterion:
        "a `candidate` holding at least one competition registration, one submission, one " +
        "notification and one manual payment proof; ties broken by lowest `users.id`",
      matched: matching.length,
    };
  }

  const deletable = await deletableAccounts(sql);
  const base =
    "an account with at least one registration, profile or institution membership, whose " +
    "`delete from users` the engine completes in a rolled-back attempt";

  if (deletable.length === 0) {
    throw new ProcedureRefusal(
      "no account with attributable rows can be deleted, so there is nothing to demonstrate a " +
        "completed deletion against",
    );
  }

  if (which === "completable") {
    return {
      userId: deletable[0]!,
      criterion: `${base}; ties broken by lowest \`users.id\``,
      matched: deletable.length,
    };
  }

  // The two criteria below narrow the same population by what the case needs to have something to
  // lose. Both are asked of the same readers the run itself uses, so the case cannot come to rest
  // on an account that makes its own omission invisible.
  if (which === "completable-with-objects") {
    const holding: { id: string; keys: number }[] = [];
    for (const id of deletable) {
      const keys = await countObjectKeys(sql, id);
      if (keys.length > 0) holding.push({ id, keys: keys.length });
    }
    if (holding.length === 0) {
      throw new ProcedureRefusal(
        "no deletable account holds an R2 object key, so removing the object-key capture would " +
          "leave nothing to fail to capture and the case would report a pass it had not earned",
      );
    }
    return {
      userId: holding[0]!.id,
      criterion: `${base}, and holding at least one R2 object key; ties broken by lowest \`users.id\``,
      matched: holding.length,
    };
  }

  if (which === "completable-with-identities") {
    const named: string[] = [];
    for (const id of deletable) {
      const literals = await readIdentities(sql, id);
      if (literals.length > 0) named.push(id);
    }
    if (named.length === 0) {
      throw new ProcedureRefusal(
        "no deletable account holds a readable identity string, so removing the identity capture " +
          "would leave nothing to fail to capture and the case would report a pass it had not earned",
      );
    }
    return {
      userId: named[0]!,
      criterion:
        `${base}, and holding at least one non-empty identity string on \`users\` or ` +
        "`candidate_profiles`; ties broken by lowest `users.id`",
      matched: named.length,
    };
  }

  throw new ProcedureRefusal(
    `--select takes \`blocked\`, \`completable\`, \`completable-with-objects\` or ` +
      `\`completable-with-identities\`, not \`${which}\``,
  );
};

if (process.argv[1]?.endsWith("run-deletion-procedure.ts")) {
  main().catch((error: unknown) => {
    // A shared-guard refusal already opens with this runner's verb — the guard takes it as a
    // parameter (LAUNCH-D144) — so prefixing it here would say "refusing to delete" twice. Every
    // other failure is this runner's own and is prefixed here, so an operator always reads what was
    // refused and in whose name rather than a bare object dump.
    const message =
      error instanceof ResetRefused
        ? error.message
        : `refusing to delete: ${error instanceof Error ? error.message : String(error)}`;

    console.error(message);

    if (error instanceof Error && error.stack !== undefined) {
      // The stack WITHOUT its first line, which repeats the message just printed.
      console.error(error.stack.split("\n").slice(1).join("\n"));
    }

    process.exitCode = 1;
  });
}
