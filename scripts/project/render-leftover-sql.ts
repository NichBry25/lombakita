/**
 * Print a fragment the procedure document embeds, so it is pasted rather than typed.
 *
 *   node --import tsx scripts/project/render-leftover-sql.ts listing|absent|groups
 *
 * `listing` and `absent` are the two SQL fragments (`renderLeftoverListingSql`,
 * `renderLeftoverAbsentSql`). `groups` is the prose list of the blocking groups and the allowed
 * edges, rendered from the same rulings.
 */

import {
  BLOCKING_GROUPS,
  LEFTOVER_RULINGS,
  renderLeftoverAbsentSql,
  renderLeftoverListingSql,
} from "./promotion-leftover-census";

const edgeName = (ruling: { table: string; column: string }): string =>
  `\`${ruling.table}.${ruling.column}\``;

const renderGroups = (): string => {
  const blockingLines = BLOCKING_GROUPS.map((group) => {
    const edges = LEFTOVER_RULINGS.filter(
      (ruling) => ruling.ruling === "blocks" && ruling.group === group,
    ).map(edgeName);
    return `- **${group}** — ${edges.join(", ")}`;
  });

  const allowedEdges = LEFTOVER_RULINGS.filter((ruling) => ruling.ruling === "allowed").map(
    edgeName,
  );

  return [...blockingLines, "", `Allowed to remain: ${allowedEdges.join(", ")}.`].join("\n");
};

const which = process.argv[2];

if (which === "listing") {
  console.log(renderLeftoverListingSql());
} else if (which === "absent") {
  console.log(renderLeftoverAbsentSql());
} else if (which === "groups") {
  console.log(renderGroups());
} else {
  console.error("usage: render-leftover-sql.ts listing|absent|groups");
  process.exitCode = 1;
}
