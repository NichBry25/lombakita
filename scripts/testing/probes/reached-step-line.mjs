/*
 * The line a script prints when it reaches a named step, DERIVED from that script's own source.
 *
 * Shared by every probe whose clause 3 has to know the child got far enough to be measuring
 * something. A fixture that restates the line asserts a value the code is free to move, and clause 3
 * then throws over a fixture that has stopped describing its subject while the guard underneath it is
 * fine — which is LAUNCH-D128, where a pinned `[2/6]` outlived the reset's seventh step and took all
 * five probes with it. So nothing about the line is pinned here: the step number, the total, the
 * title and the print format are all read out of the file the child is about to run.
 *
 * TWO SHAPES, because this repository prints a step two ways and both are waited on:
 *   - a `console.log` whose literal carries the title, as `scripts/reindex-search-index.ts` prints
 *     each of its four steps;
 *   - a `step(n, "title")` call resolved through the helper's print template and `TOTAL_STEPS`, as
 *     `scripts/reset/reset-local.ts` prints the reset's seven.
 * A file is read for one shape and then the other.
 *
 * THE ONE THING THE CALLER SUPPLIES IS THE TITLE ANCHOR, and it is a different kind of value from
 * everything else here: it names WHICH step the probe is waiting at. There is no way to derive the
 * drop step's identity from a script that is free to renumber and reorder its steps, so the anchor
 * has to be stated — while the number, the total, the brackets and the wording around it are read.
 * An anchor that has moved refuses by name rather than comparing against a guess (Rule 38), and a
 * title matching more than one printed line refuses the same way, because which line the child
 * reached could then be either.
 *
 * Read per run rather than once at import. `probe-coverage.test.ts` imports each suite as data, so a
 * module-scope throw here would fail that test rather than the suite that has something to measure;
 * and two of the probes that call this mutate the script they are about to run, so the line has to
 * come from the file that will actually run.
 */
import { readFileSync } from "node:fs";

/** A `console.log` whose whole argument is one string. A computed argument prints no step line. */
const PRINT_CALL = /console\.log\((`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g;

/** The `step(…)` helper: its call sites, the total its print template interpolates, and the template. */
const STEP_CALL = /step\((\d+), "([^"]*)"\)/g;
const TOTAL_STEPS = /^const TOTAL_STEPS = (\d+);$/gm;
const PRINT_TEMPLATE = /console\.log\(`([^`]*)`\)/g;

/**
 * The bracketed fragment of a printed line, taken from its first `[` to the end of the string.
 *
 * The bracket is what tells a step line apart from everything else a script writes, so a line
 * without one cannot be waited for at all. Starting at the bracket is also what keeps the leading
 * newline — which every one of these lines is printed with — out of the caller's anchor.
 */
const bracketedIn = (printed, what, sourcePath) => {
  const at = printed.indexOf("[");

  if (at === -1) {
    throw new Error(
      `${what} in ${sourcePath} carries no bracket, so the line it prints cannot be told apart ` +
        `from the rest of the output: \`${printed}\`. Refusing.`,
    );
  }

  return printed.slice(at);
};

/** Shape 1 — a `console.log` whose literal carries the title. */
const theLiteralCarrying = (source, title, sourcePath) => {
  const carrying = [...source.matchAll(PRINT_CALL)]
    .map(([, argument]) => argument)
    .filter((argument) => !argument.includes("${"))
    .map((argument) => argument.slice(1, -1))
    .filter((printed) => printed.includes(title));

  if (carrying.length === 0) return null;

  if (carrying.length > 1) {
    throw new Error(
      `${sourcePath} prints more than one line carrying "${title}", so which of them the child ` +
        `reached cannot be told: ${carrying.map((printed) => `\`${printed}\``).join(", ")}. ` +
        "Refusing.",
    );
  }

  return bracketedIn(carrying[0], `the line carrying "${title}"`, sourcePath);
};

/** Shape 2 — a `step(n, "title")` call, resolved through the helper's template and the total. */
const throughTheStepHelper = (source, title, sourcePath) => {
  const calls = [...source.matchAll(STEP_CALL)].filter(([, , callTitle]) =>
    callTitle.includes(title),
  );
  const templates = [...source.matchAll(PRINT_TEMPLATE)]
    .map(([, template]) => template)
    .filter((template) => template.includes("${number}") && template.includes("${title}"));
  const totals = [...source.matchAll(TOTAL_STEPS)].map(([, total]) => total);

  const missing = [
    [`a step(…) call whose title carries "${title}"`, calls],
    ["the print template that step(…) formats", templates],
    ["TOTAL_STEPS", totals],
  ]
    .filter(([, found]) => found.length === 0)
    .map(([anchor]) => anchor);

  if (missing.length > 0) {
    throw new Error(
      `cannot derive the line ${sourcePath} prints when it reaches the "${title}" step: ` +
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in it, and no ` +
        "console.log prints a line carrying that title. Refusing rather than comparing against a " +
        "guess.",
    );
  }

  for (const [what, found] of [
    [`more than one step(…) call whose title carries "${title}"`, calls],
    ["more than one print template for a step", templates],
  ]) {
    if (found.length > 1) {
      throw new Error(
        `${sourcePath} carries ${what}, so which line the child reached cannot be told. Refusing.`,
      );
    }
  }

  const [, number, callTitle] = calls[0];

  return bracketedIn(templates[0], `the step(…) print template`, sourcePath)
    .replace("${number}", number)
    .replace("${TOTAL_STEPS}", totals[0])
    .replace("${title}", callTitle);
};

/**
 * The line `sourcePath` prints when it reaches the step whose title carries `titleAnchor`.
 *
 * Throws rather than returning a fragment when the anchor has moved, when the printed line carries
 * no bracket, or when the anchor matches more than one line.
 */
export const reachedStepLine = (sourcePath, titleAnchor) => {
  const source = readFileSync(sourcePath, "utf8");

  const printed = theLiteralCarrying(source, titleAnchor, sourcePath);

  return printed ?? throughTheStepHelper(source, titleAnchor, sourcePath);
};
