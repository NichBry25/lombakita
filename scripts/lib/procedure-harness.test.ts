// @vitest-environment node
//
// THE FENCE GRAMMAR, PROVED AGAINST THE SHAPES THAT BROKE IT.
//
// Every case below is a line Markdown reads as the start of a code block and the pre-fix parser did
// not. The pre-fix predicate capped the indentation at three spaces, so "does not match the narrow
// form" was read as "is not a fence" for exactly the shapes a deeper indent produces; and because a
// skipped opener left its CLOSING fence to be read as the next opener, an illustrative bare ``` then
// swallowed everything up to the following fence — taking a real step with it. The last fix closed
// the first half and missed the four-space case, which is what this file exists to prevent recurring.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT. Each case asserts the CLASS and the line the
// refusal names, because that pair is what differs per shape and what a regression changes. The
// refusal TEXT is quoted in full in the step's report rather than duplicated here — a second copy of
// a sentence drifts from the first, and Rule 23's test for a comment applies to a test's prose too.

import { describe, expect, it } from "vitest";
import { ResetRefused } from "../reset/reset-guard";
import {
  ProcedureRefusal,
  connectToGuardedDatabase,
  parseProcedureSteps,
  type ProcedureStep,
} from "./procedure-harness";

/** A document from explicit lines, so indentation is visible in the source rather than inferred. */
const markdown = (...lines: string[]): string => `${lines.join("\n")}\n`;

/**
 * The refusal `source` produces, as text.
 *
 * Reaching the end without a throw is a failure rather than a return value: a document that parses
 * has been read, and every case here is one the grammar must refuse rather than read.
 */
const refusalFor = (source: string): string => {
  try {
    parseProcedureSteps(source);
  } catch (error) {
    if (error instanceof ProcedureRefusal) return error.message;
    throw error;
  }
  throw new Error("expected a ProcedureRefusal, but the document parsed");
};

/** The sentence's opening, which names the line and quotes it back verbatim. */
const opensACodeBlockThisHarnessCannotRead = (line: string, at: number): string =>
  `line ${at} opens a code block this harness cannot read: ${JSON.stringify(line)}.`;

const A_VALID_BLOCK = ["```sql", "-- step: first", "select 1;", "```"];

describe("a fence-like line this grammar cannot read", () => {
  // The eight shapes the step names, each with the line its refusal must point at. `at` is the
  // discriminator: a refusal that named a different line would mean the scan had already moved past
  // the line it should have stopped on, which is the swallow these cases exist to make impossible.
  const shapes: { name: string; lines: string[]; at: number }[] = [
    {
      name: "a ```sql indented by four spaces",
      lines: ["    ```sql", "-- step: hidden", "select 1;", "```"],
      at: 1,
    },
    {
      name: "a ```sql indented by eight spaces",
      lines: ["        ```sql", "-- step: hidden", "select 1;", "```"],
      at: 1,
    },
    {
      name: "a ```sql indented by a tab",
      lines: ["\t```sql", "-- step: hidden", "select 1;", "```"],
      at: 1,
    },
    {
      name: "a fence of four backticks",
      lines: ["````sql", "-- step: hidden", "select 1;", "````"],
      at: 1,
    },
    {
      name: "a ```sql followed by trailing spaces",
      lines: ["```sql   ", "-- step: hidden", "select 1;", "```"],
      at: 1,
    },
    {
      name: "a tilde fence, alone on its line",
      lines: ["~~~"],
      at: 1,
    },
    {
      name: "a valid block, a four-space-indented ```sql, then another valid block",
      lines: [
        ...A_VALID_BLOCK,
        "    ```sql",
        "-- step: swallowed",
        "select 2;",
        "```",
        "```sql",
        "-- step: third",
        "select 3;",
        "```",
      ],
      // LINE 5, not 9 or 12. Refusing here is the whole difference between this grammar and the old
      // one: the old parser read `    ```sql` as prose, then read the ``` on line 8 as an opening
      // bare fence — illustrative, so it swallowed `-- step: third` along with it.
      at: 5,
    },
  ];

  for (const shape of shapes) {
    it(`refuses ${shape.name}`, () => {
      const source = markdown(...shape.lines);

      expect(refusalFor(source)).toContain(
        opensACodeBlockThisHarnessCannotRead(shape.lines[shape.at - 1]!, shape.at),
      );
    });
  }

  it("refuses an unrecognised info word, and says which word it could not read", () => {
    // `SQL` in the wrong case. This one reaches the vocabulary check rather than the shape check,
    // which is why it carries a different sentence: the line IS a fence this grammar can see, and
    // what it cannot do is execute it.
    expect(refusalFor(markdown("```SQL", "-- step: hidden", "select 1;", "```"))).toContain(
      "line 1 opens a `SQL` block, which this harness does not know how to handle.",
    );
  });

  it("refuses a fence-like line INSIDE an open block, where it cannot be that block's closer", () => {
    // The in-block arm. `  ```sql` cannot close the block opened on line 1 — a closer is three
    // backticks and nothing else — so reading past it ends the block somewhere it does not end.
    const source = markdown("```sql", "-- step: outer", "  ```sql", "select 1;", "```");

    expect(refusalFor(source)).toContain(
      "contains a fence-like line at line 3 that cannot close it",
    );
  });

  it("refuses a block that is never closed", () => {
    expect(refusalFor(markdown("```sql", "-- step: unterminated", "select 1;"))).toContain(
      "the fence opened at line 1 is never closed",
    );
  });

  it("refuses an executable block with no step header", () => {
    expect(refusalFor(markdown("```sql", "select 1;", "```"))).toContain(
      "the `sql` block at line 1 has no `step: <name>` on its first line",
    );
  });

  it("refuses a step name declared twice", () => {
    const source = markdown(
      "```sql",
      "-- step: promote",
      "select 1;",
      "```",
      "```sql",
      "-- step: promote",
      "select 2;",
      "```",
    );

    expect(refusalFor(source)).toContain(
      "step `promote` is declared twice; a report listing it once would hide the other",
    );
  });
});

describe("the accepted form", () => {
  // THE CONTROL. Every refusal above would pass against a parser that refused everything, which is
  // the same defect one level up — and it is the reason these assertions are about the grammar
  // rather than about the parser failing.
  it("parses the accepted form to the step it declares", () => {
    const steps: ProcedureStep[] = parseProcedureSteps(
      markdown("```sql", "-- step: promote", "select 1;", "```"),
    );

    expect(steps).toEqual([
      { kind: "sql", name: "promote", body: "-- step: promote\nselect 1;", line: 1 },
    ]);
  });

  it("reads an illustrative block and hands back no step for it", () => {
    const steps = parseProcedureSteps(
      markdown(
        "```text",
        "IDENTITY=someone@example.test",
        "```",
        "```sql",
        "-- step: promote",
        "select 1;",
        "```",
      ),
    );

    expect(steps.map((step) => step.name)).toEqual(["promote"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The guard, measured by execution rather than by a grep over either runner's source.
// ---------------------------------------------------------------------------------------------

/**
 * A loopback address with nothing behind it, and a host the guard must refuse outright.
 *
 * No inline credential: both checks under test read the host and nothing else, so a user and
 * password here would be decoration carrying the exact shape `verify:secrets` exists to catch.
 */
const DEAD_LOOPBACK = "postgres://127.0.0.1:59432/lombakita_absent";
const REMOTE_HOST = "postgres://db.invalid.example.com:5432/lombakita_absent";

describe("connectToGuardedDatabase", () => {
  it("rejects rather than returning a handle, when the target is not disposable", async () => {
    await expect(
      connectToGuardedDatabase(REMOTE_HOST, { appEnv: "local", redisUrl: null }),
    ).rejects.toBeInstanceOf(ResetRefused);
  });

  // THE ORDERING, and the reason the assertion above is about the guard rather than about a
  // connection failing for its own reasons. Both layers object here; only one refusal can be
  // produced, and it is the environment's — which is only possible if the configuration layers ran
  // BEFORE anything touched a socket. A handle returned ahead of the guard resolves instead.
  it("asks the environment before the host, and before any socket is used", async () => {
    await expect(
      connectToGuardedDatabase(REMOTE_HOST, { appEnv: "production", redisUrl: null }),
    ).rejects.toThrow('refusing to reset: APP_ENV resolves to "production"');
  });

  // The other side of the same measurement: a disposable environment on a loopback address clears
  // both configuration layers and reaches the identity layer, which is where it then fails. Without
  // this, the two assertions above would pass against a helper that refused unconditionally.
  it("clears the configuration layers and reaches the server, on a disposable loopback target", async () => {
    await expect(
      connectToGuardedDatabase(DEAD_LOOPBACK, { appEnv: "local", redisUrl: null }),
    ).rejects.not.toBeInstanceOf(ResetRefused);
  });
});
