/**
 * Execute `docs/operations/operator-provisioning-procedure.md` against a local database.
 *
 * WHAT THIS IS. A reader for the procedure, not a second copy of it. Every statement that touches
 * data lives in the document; this file extracts the fenced blocks, runs the `sql` ones in document
 * order inside one transaction, and reports what each returned. Nothing here knows what the
 * procedure does — which is what makes the document the artifact and this the harness, and what
 * makes a step's absence in the document visible as a step that did not run.
 *
 * WHY A TRANSACTION, AND WHY IT IS ALWAYS ROLLED BACK. This procedure promotes accounts. A run that
 * committed would hand an account `platform_ops` for real, with no audit row (see the document's
 * STOP banner) and no later way to tell it happened. So the transaction exists for the opposite
 * reason the deletion harness's does: not to make a failure atomic, but to make a SUCCESS atomic —
 * the promotion lands, the end state is read from inside the same transaction, and then it is
 * undone. A demonstration leaves the database byte-identical.
 *
 * WHY THE STATE IS READ BY THIS FILE AND NOT BY THE DOCUMENT'S OWN STEPS. The document's
 * `postcondition` step is part of what is being demonstrated. A harness that measured the run with
 * that step would be asking the procedure whether the procedure worked. `readProvisioningState`
 * below is this file's own query, and the gate's answer is produced by the application's own
 * `resolveMfaStatus` — a reader of the row the run left behind that does not run inside the run.
 *
 * THAT INDEPENDENCE IS OF EXECUTION, NOT OF DERIVATION, and the difference is worth stating rather
 * than leaving the claim to sound stronger than it is. `readProvisioningState` and the document's
 * `postcondition` step are the SAME QUERY — same predicate, same columns — written twice by the same
 * author from the same reading of the schema. So the harness cannot be fooled by the procedure
 * failing to run its own check, which is what "independent" buys here; it CAN be fooled by both
 * copies being wrong in the same way, and nothing in this file would show it. What is not a
 * restatement of this file's arithmetic is the gate: `resolveMfaStatus` is application code with its
 * own tests, and it is the one reader here this procedure's author did not write for this purpose.
 *
 * Usage:
 *   node --import tsx scripts/project/run-provisioning-procedure.ts <userId>
 *   node --import tsx scripts/project/run-provisioning-procedure.ts --select provisioned|self-service-unenrolled
 *   node --import tsx scripts/project/run-provisioning-procedure.ts --demonstrate --out <path>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import type { AppEnvironment } from "@/config/env";
import { resolveMfaStatus, type MfaStatus } from "@/server/auth/mfa/mfa-status";
import { loadEnvFile } from "@/server/scripts/env-file";
import {
  assertResetTargetIsDisposable,
  declaredAppEnvironment,
  presentOrUndefined,
} from "../reset/reset-guard";

export const PROCEDURE_PATH = "docs/operations/operator-provisioning-procedure.md";
export const DEMONSTRATION_PATH = "docs/operations/operator-provisioning-demonstration.md";

/** The fenced info strings that name a step the operator is meant to perform. */
const EXECUTABLE_FENCES = new Set(["sql", "browser"]);

/** Fenced info strings that are illustrative and are skipped without a step header. */
const ILLUSTRATIVE_FENCES = new Set(["text", "json", ""]);

/** The one opener shape this harness reads: a backtick fence at column zero, one word of info. */
const ACCEPTED_OPENING_FENCE = /^```(\S*)\s*$/;

/** The one closer shape it reads. Anything else closing a block is a desynchronised scan. */
const ACCEPTED_CLOSING_FENCE = /^```\s*$/;

/**
 * A line that BEGINS a code block in Markdown, whether or not this file can read it.
 *
 * Deliberately wider than the accepted form. CommonMark allows up to three spaces of indentation
 * and either backticks or tildes, and permits an info string with more than one word — so
 * ` ```sql copy `, an indented ```sql, and `~~~sql` are all real code blocks that the narrow regex
 * above does not match. Treating "does not match the narrow form" as "is not a fence" is what made
 * this parser skip them in silence, and in one case swallow a VALID step that followed: the
 * malformed opener's closing fence was then read as an opening bare fence, which is illustrative
 * and consumes everything to the next one. Refusing on this predicate instead is what makes the
 * docstring's "refuses rather than skips" true of every block the narrow form would miss.
 */
const ANY_FENCE_LIKE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;

/** One step of the procedure, as the document declares it. */
export type ProcedureStep = {
  /** The fence's info string. `sql` is executed; `browser` is named and never executed. */
  kind: "sql" | "browser";
  name: string;
  body: string;
  /** The line the fence opens on, so a refusal can name where to look. */
  line: number;
};

export class ProcedureRefusal extends Error {}

/**
 * The procedure's steps, in document order.
 *
 * Refuses rather than skips, on four counts: a fence this harness cannot read, a fence it can read
 * but must not ignore, an executable block with no `-- step:` header, and a step name used twice.
 * Each of those is a way for the document to disagree with what actually runs, and a silent skip
 * turns that disagreement into a report of a step that was never performed.
 */
export const parseProcedure = (markdown: string): ProcedureStep[] => {
  const lines = markdown.split("\n");
  const steps: ProcedureStep[] = [];
  const seen = new Set<string>();

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const opening = ACCEPTED_OPENING_FENCE.exec(line);

    if (opening === null) {
      if (ANY_FENCE_LIKE_LINE.test(line)) {
        throw new ProcedureRefusal(
          `line ${index + 1} opens a code block this harness cannot read: ${JSON.stringify(line)}. ` +
            "It reads only a backtick fence at column zero whose info string is one word — " +
            "`sql`, `browser`, or one of the illustrative forms. A block it cannot read is a block " +
            "whose steps nobody would know were skipped, so it refuses instead of reading past it",
        );
      }
      index += 1;
      continue;
    }

    const fence = opening[1]!;
    const openedAt = index + 1;
    const body: string[] = [];
    index += 1;

    while (index < lines.length) {
      const candidate = lines[index]!;
      if (ACCEPTED_CLOSING_FENCE.test(candidate)) break;

      // A fence-like line that is not the closer means the scan is out of step with the document:
      // reading past it would end this block somewhere it does not end, or run to EOF.
      if (ANY_FENCE_LIKE_LINE.test(candidate)) {
        throw new ProcedureRefusal(
          `the fence opened at line ${openedAt} contains a fence-like line at line ${index + 1} ` +
            `that cannot close it: ${JSON.stringify(candidate)}. The block would swallow whatever ` +
            "follows it, so it refuses rather than guessing where the block ends",
        );
      }

      body.push(candidate);
      index += 1;
    }
    if (index === lines.length) {
      throw new ProcedureRefusal(`the fence opened at line ${openedAt} is never closed`);
    }
    index += 1;

    if (ILLUSTRATIVE_FENCES.has(fence)) continue;
    if (!EXECUTABLE_FENCES.has(fence)) {
      throw new ProcedureRefusal(
        `line ${openedAt} opens a \`${fence}\` block, which this harness does not know how to ` +
          "handle. A block it ignored would be a step nobody knows was skipped",
      );
    }

    const header = /^(?:--|#)\s*step:\s*(\S+)\s*$/.exec(body[0] ?? "");
    if (header === null) {
      throw new ProcedureRefusal(
        `the \`${fence}\` block at line ${openedAt} has no \`step: <name>\` on its first line`,
      );
    }

    const name = header[1]!;
    if (seen.has(name)) {
      throw new ProcedureRefusal(
        `step \`${name}\` is declared twice; a report listing it once would hide the other`,
      );
    }
    seen.add(name);

    steps.push({
      kind: fence as ProcedureStep["kind"],
      name,
      body: body.join("\n"),
      line: openedAt,
    });
  }

  return steps;
};

/** How a step's exception reads in the report, without the driver type in the way. */
export type DescribedError = { message: string; code: string | null; constraint: string | null };

/**
 * What one executed step returned, as the report sees it.
 *
 * `rows` and `affected` are reported separately rather than as one number, because the driver's
 * count means different things depending on the statement: for a `SELECT` it is the rows returned,
 * and for an `UPDATE` the row array is empty and the count is the rows MATCHED. A single "rows"
 * column would print `0` for a promotion that matched exactly one row — the report of a successful
 * step reading as the report of a step that did nothing, which is the failure mode this whole
 * document exists to avoid.
 */
export type StepOutcome = {
  name: string;
  /** The rows a row-returning statement returned; empty for a statement that returns none. */
  rows: Record<string, unknown>[];
  /** The driver's count for a statement that returns no rows; null for one that does. */
  affected: number | null;
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

/**
 * The account's provisioning state, read by this file with its own query.
 *
 * `isProvisioned` is the procedure's completion predicate — `users.role = 'platform_ops'` AND a
 * verified MFA factor — computed here from the two columns rather than taken from the document's
 * `postcondition` step, so the report of a run does not depend on the run's own arithmetic.
 *
 * `mfaStatus` is the APPLICATION's answer, not this file's. `resolveMfaStatus` is the one place the
 * three-state gate is decided, and it is asked here with the row the run left behind and with no
 * `mfaVerifiedAt` claim on the token — which is the state of every session that existed before the
 * account was enrolled. That is the honest input: a token minted after enrolment would carry the
 * claim, and no such token exists at the moment a procedure finishes.
 */
export type ProvisioningState = {
  userId: string;
  role: string;
  suspendedAt: Date | null;
  mfaInvalidatedAt: Date | null;
  hasVerifiedFactor: boolean;
  isProvisioned: boolean;
  mfaStatus: MfaStatus;
};

/**
 * What the account's row says, asked independently of the procedure.
 *
 * `hasVerifiedFactor` is the same predicate the gate reads — a verified factor row, not a
 * non-null `verified_at` read loosely — written here as SQL because this is a raw connection and
 * cannot call `hasVerifiedMfaFactorSql`. The document's steps 2 and 6 write the same predicate out
 * for the same reason.
 */
const readProvisioningState = async (
  sql: postgres.Sql,
  userId: string,
): Promise<ProvisioningState | null> => {
  const [row] = await sql<
    {
      id: string;
      role: string;
      suspended_at: Date | null;
      mfa_invalidated_at: Date | null;
      has_verified_factor: boolean;
    }[]
  >`
    select
      u.id,
      u.role::text as role,
      u.suspended_at,
      u.mfa_invalidated_at,
      exists (
        select 1 from mfa_factors mf
        where mf.user_id = u.id and mf.verified_at is not null
      ) as has_verified_factor
    from users u
    where u.id = ${userId}
  `;

  if (row === undefined) return null;

  const hasVerifiedFactor = row.has_verified_factor;
  const isProvisioned = row.role === "platform_ops" && hasVerifiedFactor;

  return {
    userId: row.id,
    role: row.role,
    suspendedAt: row.suspended_at,
    mfaInvalidatedAt: row.mfa_invalidated_at,
    hasVerifiedFactor,
    isProvisioned,
    mfaStatus: resolveMfaStatus({
      role: row.role,
      hasVerifiedFactor,
      mfaInvalidatedAt: row.mfa_invalidated_at,
      tokenMfaVerifiedAtSeconds: undefined,
    }),
  };
};

const sameTimestamp = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * Whether two reads of the account agree on everything the state carries.
 *
 * Field by field rather than by `JSON.stringify`, because two of the fields are `Date` objects: a
 * stringify comparison would compare them as strings and would turn a key reordering into a change.
 * This function IS the measurement, so it must not be a proxy for it.
 */
const sameState = (a: ProvisioningState | null, b: ProvisioningState | null): boolean => {
  if (a === null || b === null) return a === b;

  return (
    a.userId === b.userId &&
    a.role === b.role &&
    a.hasVerifiedFactor === b.hasVerifiedFactor &&
    a.isProvisioned === b.isProvisioned &&
    a.mfaStatus === b.mfaStatus &&
    sameTimestamp(a.suspendedAt, b.suspendedAt) &&
    sameTimestamp(a.mfaInvalidatedAt, b.mfaInvalidatedAt)
  );
};

export type ProcedureRun = {
  steps: StepOutcome[];
  /** The account's state as the run left it, read inside the run's own transaction. */
  state: ProvisioningState | null;
  /** False when a step threw, in which case no state could be read and nothing was left behind. */
  completedWithoutError: boolean;
  /**
   * Whether the database came back to what it was, MEASURED from the row rather than asserted.
   *
   * The row is read before the transaction opens and again after it closes, and this is the answer to
   * "do those two reads agree". A constant `true` beside a `rollback` call would report the harness's
   * INTENT: a rollback that silently failed, or a step that reached a commit on a connection of its
   * own, would leave the write in place while the report still read "rolled back".
   *
   * VACUOUS WHEN THE ACCOUNT DOES NOT EXIST — two reads of nothing agree. The selection is what
   * guarantees a real account; this flag cannot tell you the account was there.
   */
  rolledBack: boolean;
};

/**
 * Run the `sql` steps in order, in one transaction that is always rolled back.
 *
 * The transaction is opened and closed explicitly rather than through a callback so that the end
 * state can be read at the point the run finished, inside the same transaction, and then discarded.
 * A callback-shaped transaction would roll back before anything could look, and the residue this
 * whole demonstration is about is exactly what the run left behind.
 *
 * A step that throws aborts the transaction, so the state read is skipped and the report says so:
 * the account was not left in an intermediate state, it was not left in any state at all.
 */
export const runProcedure = async (
  sql: postgres.Sql,
  steps: readonly ProcedureStep[],
  userId: string,
): Promise<ProcedureRun> => {
  const run: ProcedureRun = {
    steps: [],
    state: null,
    completedWithoutError: true,
    rolledBack: false,
  };

  // Read BEFORE the transaction opens, so the comparison below has something to compare against.
  const before = await readProvisioningState(sql, userId);

  await sql.unsafe("begin");
  try {
    for (const step of steps) {
      if (step.kind !== "sql") {
        run.steps.push({ name: step.name, rows: [], affected: null, error: null });
        continue;
      }

      try {
        const result = (await sql.unsafe(step.body, [userId])) as Record<string, unknown>[] & {
          count: number;
          command: string;
        };
        const returnsRows = result.command === "SELECT";
        run.steps.push({
          name: step.name,
          rows: returnsRows ? result : [],
          affected: returnsRows ? null : result.count,
          error: null,
        });
      } catch (error) {
        run.steps.push({ name: step.name, rows: [], affected: null, error: describeError(error) });
        run.completedWithoutError = false;
        break;
      }
    }

    if (run.completedWithoutError) {
      run.state = await readProvisioningState(sql, userId);
    }

    await sql.unsafe("rollback");

    // After the transaction has closed, on the same connection, the way the failure path reads the
    // row back. This is the measurement; `run.rolledBack` above is only where it lands.
    run.rolledBack = sameState(before, await readProvisioningState(sql, userId));

    return run;
  } catch (error) {
    await sql.unsafe("rollback").catch(() => undefined);
    throw error;
  }
};

/** The population a criterion names, and how many accounts it matched. */
export type Selection = {
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
  omitted: readonly string[];
  run: ProcedureRun;
};

/**
 * The cases the demonstration runs, and why each one exists.
 *
 * These are cases, not a population: which ACCOUNT each one runs against is derived at run time by
 * `selectTarget`. The list is fixed because a demonstration is a chosen set of situations; the
 * subject of each is not, because a subject chosen to succeed demonstrates nothing.
 *
 * The residue this phase is about is an OMITTED STEP, and the procedure has two steps whose
 * omission is representable — `promote`, which the CAS update performs, and `enrol`, which is a
 * browser session the harness cannot run for any case. Cases C and B separate them: omitting
 * `promote` leaves the account where it started, and omitting `enrol` leaves it promoted and
 * unguarded-and-gated. The two omissions are detectable, and they are detectable differently,
 * which is the whole of the claim.
 */
export const DEMONSTRATION_CASES: readonly {
  label: string;
  purpose: string;
  select: string;
  omit: readonly string[];
}[] = [
  {
    label: "Case A — an account the procedure has already produced",
    purpose:
      "Holds `platform_ops` and a verified factor. `promote` is omitted because the procedure's own " +
      "step 2 stops on an account that already holds the role, so running it would be running past " +
      "the document's stop condition. This is the answer a COMPLETE provisioning reads as, and it " +
      "is what the two cases below are measured against.",
    select: "provisioned",
    omit: ["promote"],
  },
  {
    label: "Case B — a self-service account, promoted, with enrolment omitted",
    purpose:
      "Every `sql` step runs and none is omitted. `enrol` did not run, because it is a browser " +
      "session and this harness has none — which is not a choice this case makes but the state " +
      "every case in this file is in. The promotion is real and inside the transaction, so this is " +
      "the account the procedure's second half exists to hold back.",
    select: "self-service-unenrolled",
    omit: [],
  },
  {
    label: "Case C — Case B's subject, with the promotion also omitted",
    purpose:
      "The same account as Case B, with `promote` omitted too. Nothing about the account changed " +
      "between the two cases, so a difference in what the gate answers is attributable to the " +
      "promotion and to the missing enrolment — not to the subject. Without this case, Case B's " +
      "answer would not be distinguishable from an account that was always in that state.",
    select: "self-service-unenrolled",
    omit: ["promote"],
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
    entry.omitted.length === 0
      ? "Steps omitted: **none**."
      : `Steps omitted: **${entry.omitted.join(", ")}**.`,
    "",
    "| step | kind | rows | affected | outcome |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const step of entry.steps) {
    const outcome = run.steps.find((candidate) => candidate.name === step.name);
    if (outcome === undefined) {
      lines.push(`| \`${step.name}\` | ${step.kind} | — | — | not reached |`);
    } else if (outcome.error !== null) {
      const code = outcome.error.code === null ? "" : ` \`${outcome.error.code}\``;
      lines.push(`| \`${step.name}\` | ${step.kind} | — | — | refused:${code} |`);
    } else if (step.kind === "browser") {
      lines.push(`| \`${step.name}\` | ${step.kind} | — | — | named, not executed |`);
    } else if (outcome.affected === null) {
      lines.push(`| \`${step.name}\` | ${step.kind} | ${outcome.rows.length} | — | ran |`);
    } else {
      lines.push(`| \`${step.name}\` | ${step.kind} | — | ${outcome.affected} | ran |`);
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

  lines.push(
    "### What the account's row says afterwards",
    "",
    "Read by `scripts/project/run-provisioning-procedure.ts` with its own query, inside the run's",
    "own transaction, and **not** from the document's `postcondition` step — a run measured by the",
    "procedure it is measuring answers a different question.",
    "",
  );

  if (run.state === null) {
    lines.push(
      "**No state was read.** A step threw, which aborts the transaction, so there is no row the run",
      "left behind to describe. The account is exactly as it was.",
      "",
    );
    return lines;
  }

  const state = run.state;
  lines.push(
    "| column | value |",
    "| --- | --- |",
    `| \`users.role\` | \`${state.role}\` |`,
    `| \`users.suspended_at\` | ${state.suspendedAt === null ? "null" : `\`${state.suspendedAt.toISOString()}\``} |`,
    `| \`users.mfa_invalidated_at\` | ${state.mfaInvalidatedAt === null ? "null" : `\`${state.mfaInvalidatedAt.toISOString()}\``} |`,
    `| a verified factor exists | **${state.hasVerifiedFactor}** |`,
    "",
    "### The two answers",
    "",
    `The procedure's completion predicate — \`users.role = 'platform_ops'\` **and** a verified factor:`,
    `**${state.isProvisioned}**.`,
    "",
    `The application's own gate, \`resolveMfaStatus\` from \`src/server/auth/mfa/mfa-status.ts\`, asked`,
    `with this row and with no \`mfaVerifiedAt\` claim on the token: **\`${state.mfaStatus}\`**.`,
    "",
  );

  return lines;
};

/**
 * Open a connection, having first asked the reset lane's own guard whether this target is disposable.
 *
 * THE GUARD IS `assertResetTargetIsDisposable`, NOT A SECOND COPY OF IT (Rule 37). This file used to
 * compose the same three layers by hand, and it had already drifted from the original in two ways
 * nothing here could see: it never read `current_user`, so the identity it acted on was half the
 * answer the original prints; and it ran the layers in the opposite order, with no test in either
 * file discriminating the two orders. The `IdentifiableConnection` type on that function is
 * structural precisely so another lane's connection can be passed to it.
 *
 * The connection is returned only after the guard resolves, so a caller cannot hold a handle that
 * skipped the check — the ordering is a type constraint rather than a convention, which is the shape
 * to prefer when the statement downstream promotes an account to `platform_ops`. The guard's messages
 * say "refusing to reset" because they are the reset lane's; the refusal is what matters and the
 * wording is not restated here, because a second copy of it is the drift this fix removed.
 */
const connectToDisposableDatabase = async (
  url: string,
  appEnv: AppEnvironment,
): Promise<postgres.Sql> => {
  const sql = postgres(url, { max: 1 });

  try {
    await assertResetTargetIsDisposable(sql, { appEnv, databaseUrl: url, redisUrl: null });
    return sql;
  } catch (error) {
    await sql.end();
    throw error;
  }
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const omit = new Set<string>();
  let select: string | null = null;
  let explicitUserId: string | null = null;
  let demonstrate = false;
  let out: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--omit") {
      const name = argv[index + 1];
      if (name === undefined) throw new ProcedureRefusal("--omit needs a step name");
      omit.add(name);
      index += 1;
    } else if (argument === "--select" || argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined) throw new ProcedureRefusal(`${argument} needs a value`);
      if (argument === "--select") select = value;
      if (argument === "--out") out = value;
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
  // `presentOrUndefined`, not a bare `=== undefined` test. `DATABASE_URL=""` IS a value, so an empty
  // variable passes that test and reaches `postgres("")`, which connects to a default local socket
  // instead of refusing. Whether the variable is present is not the question; whether it names
  // anything is.
  const url = presentOrUndefined(process.env.DATABASE_URL);
  if (url === undefined) {
    throw new ProcedureRefusal(
      `DATABASE_URL is unset or empty and no env file supplied one (${loadedFrom})`,
    );
  }
  // `declaredAppEnvironment`, never `resolveAppEnvironment` directly: the latter reads only its
  // argument, NODE_ENV and VERCEL_ENV, so calling it bare answers "local" in a shell that has
  // declared production and leaves this layer inert.
  //
  // The host and environment layers are NOT checked here. They are two of the three layers
  // `assertResetTargetIsDisposable` runs, and checking them here as well is how this file came to
  // hold a second copy that ran them in the other order. They are asked at the connection, below.
  const appEnv = declaredAppEnvironment();

  const document = readFileSync(resolve(process.cwd(), PROCEDURE_PATH), "utf8");
  const declared = parseProcedure(document);
  const known = new Set(declared.map((step) => step.name));

  for (const name of omit) {
    if (!known.has(name)) {
      throw new ProcedureRefusal(
        `--omit ${name} names no step in ${PROCEDURE_PATH}; the steps are ${[...known].join(", ")}`,
      );
    }
  }

  const sql = await connectToDisposableDatabase(url, appEnv);

  try {
    if (demonstrate) {
      if (select !== null || explicitUserId !== null || omit.size > 0) {
        throw new ProcedureRefusal(
          "--demonstrate runs the fixed case list and takes no --select, user id or --omit",
        );
      }
      await demonstrateAll(sql, declared, out ?? DEMONSTRATION_PATH);
      return;
    }

    let selection: Selection;
    if (select !== null) {
      selection = await selectTarget(sql, select);
    } else if (explicitUserId !== null) {
      selection = { userId: explicitUserId, criterion: "named on the command line", matched: 1 };
    } else {
      throw new ProcedureRefusal("give a user id, --select, or --demonstrate");
    }

    const steps = declared.filter((step) => !omit.has(step.name));
    const run = await runProcedure(sql, steps, selection.userId);

    const text = renderCase({
      label: "The procedure, executed",
      purpose: "One run of the documented procedure against a derived target.",
      selection,
      declared,
      steps,
      omitted: [...omit],
      run,
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

/** Run every case in `DEMONSTRATION_CASES`, in order, and write the record of all of them to one document. */
const demonstrateAll = async (
  sql: postgres.Sql,
  declared: readonly ProcedureStep[],
  out: string,
): Promise<void> => {
  const known = new Set(declared.map((step) => step.name));
  const cases: CaseRun[] = [];

  for (const spec of DEMONSTRATION_CASES) {
    for (const name of spec.omit) {
      if (!known.has(name)) {
        throw new ProcedureRefusal(`case \`${spec.label}\` omits \`${name}\`, which is not a step`);
      }
    }

    const selection = await selectTarget(sql, spec.select);
    const steps = declared.filter((step) => !spec.omit.includes(step.name));
    const run = await runProcedure(sql, steps, selection.userId);

    cases.push({
      label: spec.label,
      purpose: spec.purpose,
      selection,
      declared,
      steps,
      omitted: spec.omit,
      run,
    });
  }

  const lines: string[] = [
    "# Operator provisioning — the procedure, executed",
    "",
    "**This file is generated. Do not edit it.**",
    "",
    "    node --import tsx scripts/project/run-provisioning-procedure.ts --demonstrate",
    "",
    `Every line below is written by \`scripts/project/run-provisioning-procedure.ts\`, executing`,
    `\`${PROCEDURE_PATH}\` against the database the configuration names. The procedure is`,
    "hand-written; this is the record of running it, and nothing here was typed in by hand.",
    "",
    "**Nothing this harness does is committed.** Every `sql` step runs inside one transaction that",
    "is always rolled back, so the promotion each case performs is undone when the process exits.",
    "The accounts named below are exactly as they were before the run.",
    "",
    "**Nothing here ran against staging or production.** The harness refuses any `DATABASE_URL`",
    "that is not a loopback host, and it refuses a process that declares an environment other than",
    "a disposable one — for a stronger reason than the deletion harness has: a run that leaked",
    "would hand an account `platform_ops`.",
    "",
    "The one step the harness cannot execute is `enrol`, and it is a `browser` fence: named in every",
    "case below, executed in none. It is not omitted by any case's choice; it is the step whose",
    "channel is a browser session, which this harness does not have. That is why the residue case is",
    "reachable at all — see the section at the end.",
    "",
    "## The cases",
    "",
    "| case | the question it answers |",
    "| --- | --- |",
    ...DEMONSTRATION_CASES.map((spec) => `| ${spec.label} | ${spec.purpose} |`),
    "",
  ];

  for (const entry of cases) lines.push(...renderCase(entry));

  const answers = cases.map((entry) => entry.run.state?.mfaStatus ?? "no state read");

  // The `promote` step's affected count, per case, read from the run rather than asserted here.
  // "The promotion ran" is a claim about the case; this is the number that makes it checkable.
  const promoted = cases.map((entry) => {
    const outcome = entry.run.steps.find((step) => step.name === "promote");
    if (outcome === undefined || outcome.affected === null) return null;
    return outcome.affected;
  });

  const promotedPhrase = (index: number): string =>
    promoted[index] === null || promoted[index] === undefined
      ? "`promote` did not run"
      : `\`promote\` affected ${promoted[index]} row(s)`;

  lines.push(
    "## What the cases together say",
    "",
    "| case | role after the run | verified factor | completion predicate | the gate's answer |",
    "| --- | --- | --- | --- | --- |",
    ...cases.map((entry) => {
      const state = entry.run.state;
      if (state === null) return `| ${entry.label} | — | — | — | no state read |`;
      return (
        `| ${entry.label} | \`${state.role}\` | ${state.hasVerifiedFactor} | ` +
        `${state.isProvisioned} | \`${state.mfaStatus}\` |`
      );
    }),
    "",
    "### The residue",
    "",
    "An omitted step is detectable only if the account it would have acted on is left in a state a",
    "later reader can tell apart from the state a complete run leaves. The cases separate the two",
    "steps whose omission is representable, and the two omissions read differently:",
    "",
    `- **\`enrol\` omitted — Case B.** ${promotedPhrase(1)}, so the account holds ` +
      `\`platform_ops\`. The gate answers \`${answers[1]}\`. A reader who finds an account with ` +
      "the role and no factor knows the procedure was stopped between its fourth and sixth steps.",
    `- **\`promote\` omitted — Case C.** ${promotedPhrase(2)}, so the account was not ` +
      `promoted and the role column still reads the one it started with. The gate answers ` +
      `\`${answers[2]}\`, which is what every unpromoted account answers and is therefore ` +
      "indistinguishable from an account the procedure never touched. The omission is detectable " +
      "as an absence of progress, not as a half-finished state.",
    `- **\`promote\` omitted by the procedure's own stop — Case A.** ${promotedPhrase(0)}, because ` +
      `the account already held the role and the CAS clause matched nothing. It answers ` +
      `\`${answers[0]}\`, which is neither of the two above, and is the answer a COMPLETE ` +
      "provisioning reads as.",
    "",
    "The three answers are three different strings, and none of them is reachable from the others by",
    "a change to the account alone. That is what makes a half-run procedure distinguishable from a",
    "complete one.",
    "",
    "### What is deliberately not demonstrated",
    "",
    "`resolve`, `preconditions`, `verify-role`, `verify-factor` and `postcondition` are reads. A read",
    "has no omission residue, because it changes nothing that a later reader could look at — omitting",
    "one leaves the database exactly as omitting none does. Stating that is the honest alternative to",
    "fabricating a case that measures nothing.",
    "",
    "## Where the procedure's steps are named",
    "",
    `The steps this run executed, in the order it executed them: ${declared
      .map((step) => `\`${step.name}\``)
      .join(" → ")}.`,
    "",
  );

  writeFileSync(resolve(process.cwd(), out), `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${out}`);
};

/**
 * Ask the database which account the criterion names.
 *
 * The populations are derived rather than listed. A hand-named account is an account chosen by the
 * person demonstrating, and an account chosen to succeed demonstrates nothing — here the risk is
 * sharper than in the deletion harness, because the residue case needs a subject that is genuinely
 * promotable and genuinely unenrolled, and the easy way to get one is to pick it.
 */
const selectTarget = async (sql: postgres.Sql, which: string): Promise<Selection> => {
  if (which === "provisioned") {
    const rows = await sql<{ id: string }[]>`
      select u.id
      from users u
      where u.role = 'platform_ops'
        and u.suspended_at is null
        and exists (
          select 1 from mfa_factors mf
          where mf.user_id = u.id and mf.verified_at is not null
        )
      order by u.id
    `;

    if (rows.length === 0) {
      throw new ProcedureRefusal(
        "no account on this database holds `platform_ops` with a verified factor, so there is " +
          "nothing to measure a completed provisioning against. The operator accounts are the " +
          "opt-in `npm run db:seed:operators` lane, which the base reset does not run",
      );
    }

    return {
      userId: rows[0]!.id,
      criterion:
        "`role = 'platform_ops'`, not suspended, and holding a verified MFA factor; ties broken " +
        "by lowest `users.id`",
      matched: rows.length,
    };
  }

  if (which === "self-service-unenrolled") {
    const rows = await sql<{ id: string }[]>`
      select u.id
      from users u
      where u.role in ('candidate', 'recruiter')
        and u.status = 'active'
        and u.suspended_at is null
        and not exists (
          select 1 from mfa_factors mf
          where mf.user_id = u.id and mf.verified_at is not null
        )
      order by u.id
    `;

    if (rows.length === 0) {
      throw new ProcedureRefusal(
        "no active, unsuspended self-service account is without a verified factor, so the account " +
          "the promotion acts on does not exist here",
      );
    }

    return {
      userId: rows[0]!.id,
      criterion:
        "`role in ('candidate', 'recruiter')`, `status = 'active'`, not suspended, and holding no " +
        "verified MFA factor; ties broken by lowest `users.id`",
      matched: rows.length,
    };
  }

  throw new ProcedureRefusal(
    `--select takes \`provisioned\` or \`self-service-unenrolled\`, not \`${which}\``,
  );
};

if (process.argv[1]?.endsWith("run-provisioning-procedure.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
