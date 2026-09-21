/**
 * The two things every procedure runner needs and neither should own a copy of.
 *
 * WHY THIS MODULE EXISTS. `run-provisioning-procedure.ts` and `run-deletion-procedure.ts` are the
 * same instrument pointed at two documents: both read a Markdown procedure, extract its fenced
 * blocks, and execute the `sql` ones inside one transaction they always roll back. Everything
 * upstream of that — how a fence is recognised, and what has to be true about the connection before
 * a statement is allowed near it — was written twice, and the two copies had already drifted in
 * ways neither file could see:
 *
 *   - the deletion runner still carried the PRE-FIX fence parser. It skipped a malformed opener
 *     silently, so a ```` ```sql ```` indented by four spaces was read as prose and its step
 *     vanished; and by skipping, its CLOSING fence could then be read as an opening bare fence,
 *     which is illustrative and swallows everything to the next one — taking a real step with it.
 *   - the deletion runner composed the disposability guard by hand, in the opposite layer order to
 *     the reset lane's, and never read `current_user` — so the identity it acted on was half of the
 *     answer the original prints.
 *
 * `scripts/reset/reset-local.ts` is the other half of the same lesson, and the same fix: three
 * copies of one predicate, collapsed into one definition.
 *
 * WHAT IS DELIBERATELY NOT HERE. Neither the step vocabulary nor the refusal policy. This module
 * reads a fence and returns a step; it does not decide which kinds a given runner is willing to
 * execute, because the two runners answer that differently and the answer is theirs. A runner that
 * silently skipped the other's kind would report a document it had not read, so each runner refuses
 * the kinds it does not run — in its own file, where that refusal can name its own document.
 */

import postgres from "postgres";
import type { AppEnvironment } from "@/config/env";
import { assertResetTargetIsDisposable } from "../reset/reset-guard";

/**
 * The info strings this grammar knows, in the two families the Markdown uses.
 *
 * The union of both runners' vocabularies rather than either one's. A parser that knew only its own
 * runner's kinds would refuse the other's document outright, which would make the shared module
 * unusable by the very caller it was extracted for; knowing the union and letting each runner refuse
 * the kinds it does not execute is what keeps "refuses rather than skips" true on both sides.
 */
const EXECUTABLE_KINDS = new Set(["sql", "browser", "r2"]);

/** Fenced blocks that illustrate rather than instruct: read, then skipped without a step header. */
const ILLUSTRATIVE_KINDS = new Set(["text", "json"]);

/**
 * The one opener shape this grammar reads: three backticks at column zero, one info word, nothing
 * after it.
 *
 * NOTHING AFTER IT is load-bearing and is the part the earlier regex got wrong. `^```(\S*)\s*$`
 * accepts ` ```sql ` with trailing spaces, which is a different line from the one the accepted set
 * names — and a grammar whose idea of an opener and whose idea of the document disagree is a grammar
 * that reads a block nobody wrote.
 *
 * NO BACKTICK IN THE INFO WORD, which is the second thing that regex got wrong and the subtler one.
 * `\S` matches a backtick, so `^```(\S+)$` reads four backticks as an opener whose info string is
 * `` `sql `` — a name that is in no accepted set, so it refuses, but it refuses for the wrong reason
 * and only AFTER consuming the block. Four backticks is a fence in its own right (a fence may be
 * longer than its opener), and the grammar this one implements says so: it is not an opener, and it
 * begins with three backticks, so it is fence-like and refuses as one, before anything is read.
 */
const OPENING_FENCE = /^```([^\s`]+)$/;

/** The one closer shape it reads: three backticks at column zero, and nothing else at all. */
const CLOSING_FENCE = /^```$/;

/**
 * A line that BEGINS a code block in Markdown, whether or not this grammar can read it.
 *
 * ANY leading whitespace, not up to three. CommonMark allows up to three spaces of indentation and
 * either backticks or tildes, and permits an info string of several words — so ` ```sql copy `, a
 * four-space-indented ` ```sql `, a tab-indented one, `~~~sql` and ` ```` ` are all real code blocks.
 * The earlier predicate capped the indent at three, which meant "does not match the narrow form" was
 * read as "is not a fence" for exactly the shapes a deeper indent produces, and the block was
 * skipped in silence — the failure this whole grammar exists to make impossible.
 *
 * `{3,}` rather than exactly three: a fence may be LONGER than its opener, so four backticks begin a
 * code block too, and a line of them must be refused rather than read past.
 */
const FENCE_LIKE_LINE = /^\s*(?:`{3,}|~{3,})/;

/** The kinds this grammar hands back for execution. Illustrative blocks never reach a caller. */
export type ProcedureStepKind = "sql" | "browser" | "r2";

/** One step of a procedure, as the document declares it. */
export type ProcedureStep = {
  /** The fence's info string. Each runner decides which of these it is willing to execute. */
  kind: ProcedureStepKind;
  name: string;
  body: string;
  /** The line the fence opens on, so a refusal can name where to look. */
  line: number;
};

/** Thrown rather than exiting, so a caller's `finally` still closes its connections (Rule 35). */
export class ProcedureRefusal extends Error {}

const refusesOpening = (line: string, at: number): ProcedureRefusal =>
  new ProcedureRefusal(
    `line ${at} opens a code block this harness cannot read: ${JSON.stringify(line)}. ` +
      "It reads only a backtick fence at column zero whose info string is one word — `sql`, " +
      "`browser`, `r2`, or one of the illustrative forms. A block it cannot read is a block " +
      "whose steps nobody would know were skipped, so it refuses instead of reading past it",
  );

/**
 * A procedure's steps, in document order.
 *
 * Refuses rather than skips, on four counts: a fence it cannot read, a fence-like line inside a
 * block that cannot close it, an executable block with no `step:` header, and a step name used
 * twice. Each is a way for the document to disagree with what actually runs, and a silent skip turns
 * that disagreement into a report of a step that was never performed.
 */
export const parseProcedureSteps = (markdown: string): ProcedureStep[] => {
  const lines = markdown.split("\n");
  const steps: ProcedureStep[] = [];
  const seen = new Set<string>();

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const opening = OPENING_FENCE.exec(line);

    if (opening === null) {
      if (FENCE_LIKE_LINE.test(line)) {
        throw refusesOpening(line, index + 1);
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
      if (CLOSING_FENCE.test(candidate)) break;

      // A fence-like line that is not the closer means the scan is out of step with the document:
      // reading past it would end this block somewhere it does not end, or run to EOF.
      if (FENCE_LIKE_LINE.test(candidate)) {
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

    if (ILLUSTRATIVE_KINDS.has(fence)) continue;
    if (!EXECUTABLE_KINDS.has(fence)) {
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
      kind: fence as ProcedureStepKind,
      name,
      body: body.join("\n"),
      line: openedAt,
    });
  }

  return steps;
};

/**
 * Open a connection, having first asked the reset lane's own guard whether this target is disposable.
 *
 * THE GUARD IS `assertResetTargetIsDisposable`, NOT A SECOND COPY OF IT (Rule 37). This path used to
 * be composed by hand in each runner, and both copies had already drifted from the original in ways
 * nothing could see: the deletion runner ran the connection-host layer BEFORE the environment one,
 * and never read `current_user`, so the identity it acted on was half the answer the original prints.
 * The `IdentifiableConnection` type on that function is structural precisely so another lane's
 * connection can be passed to it.
 *
 * WHAT "Returns the handle only after the guard passed" DOES AND DOES NOT MEAN. The handle is
 * CONSTRUCTED above the guard — postgres.js does not open a socket until a query, and the guard's
 * first two layers read only configuration, so a refused run still never reaches the server. What is
 * guaranteed here is narrower and is the part that matters: this is the ONLY place either runner can
 * obtain a query-capable handle, so a caller that skipped the check is a compile error rather than a
 * probe. It is a single-construction-site convention, NOT a type constraint — an earlier comment on
 * the provisioning runner's copy claimed the stronger thing while its own `sql` sat one line above
 * the call. On refusal the handle is closed before the error propagates, so a refusal leaks no pool.
 *
 * The guard's messages say "refusing to reset", because they are the reset lane's. The refusal is
 * what matters and the wording is not restated here: a second copy of it is exactly the drift this
 * function removed.
 */
export const connectToGuardedDatabase = async (
  url: string,
  context: { appEnv: AppEnvironment; redisUrl: string | null },
): Promise<postgres.Sql> => {
  const sql = postgres(url, { max: 1 });

  try {
    await assertResetTargetIsDisposable(sql, {
      appEnv: context.appEnv,
      databaseUrl: url,
      redisUrl: context.redisUrl,
    });
    return sql;
  } catch (error) {
    await sql.end();
    throw error;
  }
};
