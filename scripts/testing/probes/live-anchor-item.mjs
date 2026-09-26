/*
 * An item the register is actually holding, read from the register at run time.
 *
 * A probe that plants a mark on "LAUNCH-D142" stops measuring the day D142 closes — the literal it
 * mutates is still a literal, the substitution finds nothing, and the suite reads as a tree that
 * changed rather than a register that moved. The register is designed to be consumed by a close, so
 * a probe whose subject is a live item has to ASK which item is live.
 *
 * THE FIVE PROPERTIES ARE THE PROBE'S OWN REQUIREMENTS, not a description of any item:
 *
 *   1. it sits under a `### Open` heading — the probe's subject is the live set, so the item has to
 *      be in it by the arm the register files its open work under;
 *   2. its head line opens a register item, `- **<id> …`, which is the line a mark is planted on;
 *   3. the head line carries neither the discharge nor the withdrawal mark — an item already marked
 *      is one whose leaving has already happened, and marking it again measures nothing;
 *   4. the head line's anchor names a step AND a block, which is the population the anchored floor
 *      counts — the one the probe's detector waits to see fall;
 *   5. the head line's identity occurs EXACTLY ONCE in the file, because the mutation is a
 *      substitution and a second occurrence would make which line moved unknowable.
 *
 * An item that fails any of them is PASSED OVER, and the first that fails none is returned. When no
 * item qualifies the throw names the properties and how many candidates fell to each (Rule 38): a
 * probe that silently found no subject would report itself proven over an experiment it never ran,
 * and a probe that refused on the first marked item would refuse on a register full of usable ones.
 *
 * The line shapes restate definitions `scripts/project/register-census.ts` also holds, because that
 * module is TypeScript and this suite runs under plain `node`.
 */
import { readFileSync } from "node:fs";

const OPEN_SECTION = /^###\s+Open\b/;
const ANY_SECTION = /^###\s/;
const ITEM_HEAD = /^- \*\*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\[/;
const DISCHARGE_MARK = /·\s*DISCHARGED/;
const WITHDRAWAL_MARK = /·\s*WITHDRAWN/;
const CANONICAL_ANCHOR = /→\s*Step\s+[\d.]+\s+Block\s+[A-Z]\d*\b/;

const countOccurrences = (text, needle) => text.split(needle).length - 1;

/**
 * The first item under `### Open` satisfying every property above, and the part of its head line a
 * mark is planted in — everything before the `**` that closes the item's bold lead-in.
 *
 * Throws naming the properties and the tally when the register holds no such item.
 */
export const liveAnchorItem = (registerPath) => {
  const text = readFileSync(registerPath, "utf8");
  const lines = text.split("\n");

  const fellTo = {
    "already carries a mark": 0,
    "no bold lead-in to plant the mark in": 0,
    "anchor names no step and a block": 0,
    "head line is not unique in the file": 0,
  };

  let inOpen = false;
  let candidates = 0;

  for (const line of lines) {
    if (ANY_SECTION.test(line)) {
      inOpen = OPEN_SECTION.test(line);
      continue;
    }

    if (!inOpen || !ITEM_HEAD.test(line)) continue;
    candidates += 1;

    if (DISCHARGE_MARK.test(line) || WITHDRAWAL_MARK.test(line)) {
      fellTo["already carries a mark"] += 1;
      continue;
    }

    const closing = line.indexOf("**", 3);
    if (closing === -1) {
      fellTo["no bold lead-in to plant the mark in"] += 1;
      continue;
    }

    const anchored = line.slice(0, closing);
    if (!CANONICAL_ANCHOR.test(anchored)) {
      fellTo["anchor names no step and a block"] += 1;
      continue;
    }

    if (countOccurrences(text, anchored) !== 1) {
      fellTo["head line is not unique in the file"] += 1;
      continue;
    }

    return { id: ITEM_HEAD.exec(line)[1], anchored, line };
  }

  const tally = Object.entries(fellTo)
    .map(([property, count]) => `  ${count} ${property}`)
    .join("\n");

  throw new Error(
    `${registerPath}: no item satisfies the probe's properties. ${candidates} item(s) were seen ` +
      `under a \`### Open\` heading, and each fell to one of:\n${tally}\n` +
      `Refusing by name rather than leaving the probe without a subject.`,
  );
};
