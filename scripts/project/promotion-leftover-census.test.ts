// @vitest-environment node
//
// The promotion leftover census, held to the schema it derives from.
//
// WHAT THESE TESTS ARE FOR. The census exists so that the promotion procedure can refuse an account
// tied to someone else's data. Every edge is derived from the schema, so the failure this file is
// built to catch is "a foreign key into `users` was added and the promotion did not notice". Each
// assertion fails on a schema change that introduces an unruled edge, and names the edge rather than
// the shape it broke. The counts are pinned EXACTLY: a set that gains an edge is a procedure that
// changed its answer.

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeInviteEmail } from "@/server/invitations/claim-service";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import {
  BLOCKING_GROUPS,
  blockingRulings,
  derivedLeftoverEdges,
  EMAIL_KEYED_ARMS,
  LEFTOVER_RULINGS,
  PromotionLeftoverRefusal,
  renderLeftoverAbsentSql,
  renderLeftoverListingSql,
  schemaInvitedEmailColumns,
  staleLeftoverRulings,
  unruledLeftoverEdges,
} from "./promotion-leftover-census";

const edgeName = (edge: { table: string; column: string }): string =>
  `${edge.table}.${edge.column}`;

describe("the derived edges into users", () => {
  it("derives 48 edges, 17 allowed and 31 blocking, as the census derives them", () => {
    // 48/17/31 after user_password_reset_tokens.user_id (LAUNCH-D192)
    expect(derivedLeftoverEdges()).toHaveLength(48);
    expect(LEFTOVER_RULINGS.filter((ruling) => ruling.ruling === "allowed")).toHaveLength(17);
    expect(blockingRulings()).toHaveLength(31);
  });

  it("has no derived edge without a ruling", () => {
    expect(unruledLeftoverEdges()).toEqual([]);
  });

  it("has no ruling that names an edge the schema does not declare", () => {
    expect(staleLeftoverRulings()).toEqual([]);
  });

  it("rules each edge exactly once", () => {
    const names = LEFTOVER_RULINGS.map(edgeName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts every blocking ruling in one of the five named groups", () => {
    for (const ruling of blockingRulings()) {
      expect(BLOCKING_GROUPS, edgeName(ruling)).toContain(ruling.group);
    }
  });

  it("refuses by name when a single ruling is removed", () => {
    const withoutOne = LEFTOVER_RULINGS.filter(
      (ruling) => edgeName(ruling) !== "finance_payments.payer_user_id",
    );

    expect(unruledLeftoverEdges(derivedLeftoverEdges(), withoutOne)).toEqual([
      "finance_payments.payer_user_id",
    ]);
    expect(() => renderLeftoverListingSql(withoutOne)).toThrow(PromotionLeftoverRefusal);
    expect(() => renderLeftoverAbsentSql(withoutOne)).toThrow(/finance_payments\.payer_user_id/);
  });

  it("reports a ruling that names no derived edge as stale", () => {
    const withStale = [
      ...LEFTOVER_RULINGS,
      { table: "ghost_table", column: "user_id", ruling: "blocks", group: "money", reason: "x" },
    ] as const;

    expect(staleLeftoverRulings(derivedLeftoverEdges(), withStale)).toEqual([
      "ghost_table.user_id",
    ]);
  });
});

describe("the email-keyed arms", () => {
  it("cover every invited_email column the schema declares", () => {
    expect(EMAIL_KEYED_ARMS.map(edgeName).sort()).toEqual(
      schemaInvitedEmailColumns().map(edgeName),
    );
  });
});

describe("the rendered fragments", () => {
  const listing = renderLeftoverListingSql();
  const absent = renderLeftoverAbsentSql();

  it("name every blocking edge in both fragments", () => {
    for (const ruling of blockingRulings()) {
      expect(listing, edgeName(ruling)).toContain(`select '${edgeName(ruling)}' as source`);
      expect(absent, edgeName(ruling)).toContain(
        `from ${ruling.table} where ${ruling.column} = $1)`,
      );
    }
  });

  it("name no allowed edge in either fragment", () => {
    for (const ruling of LEFTOVER_RULINGS.filter((entry) => entry.ruling === "allowed")) {
      expect(listing, edgeName(ruling)).not.toContain(`'${edgeName(ruling)}'`);
      expect(absent, edgeName(ruling)).not.toContain(`from ${ruling.table} where`);
    }
  });

  it("add one guard and one listing select per edge, blocking edges then the two email arms", () => {
    expect(absent.split("\n")).toHaveLength(31 + 2);
    expect(listing.split("\n    union all\n")).toHaveLength(31 + 2);
  });

  it("match the email arms with lower(btrim(the account's email)) on the exact forms", () => {
    for (const arm of EMAIL_KEYED_ARMS) {
      expect(listing).toContain(
        `select '${arm.table}.invited_email' as source, count(*)::int as n from ${arm.table} ` +
          "where invited_email = lower(btrim((select email from users where id = $1))) " +
          "having count(*) > 0",
      );
      expect(absent).toContain(
        `  and not exists (select 1 from ${arm.table} where invited_email = ` +
          "lower(btrim((select email from users where id = $1))))",
      );
    }
  });

  it("keep $1 as the only parameter", () => {
    expect(`${listing}\n${absent}`).not.toMatch(/\$[2-9]/);
  });
});

// The SQL form the email arms use, against the application's own normaliser, over four ordinary
// addresses. The exotic cases (tab, no-break space, byte-order mark, ideographic space, dotted
// capital I, final sigma) are deliberately absent: they depend on the database locale.
const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

afterAll(async () => {
  await client?.end();
});

describe.skipIf(skipWithoutDatabase)("lower(btrim(x)) against normalizeInviteEmail", () => {
  it.each(["user@example.com", "User@Example.COM", "user+tag@example.com", " user@example.com "])(
    "agrees on %j",
    async (address) => {
      const [row] = await client!<{ normalized: string }[]>`
        select lower(btrim(${address}::text)) as normalized
      `;

      expect(row!.normalized).toBe(normalizeInviteEmail(address));
    },
  );
});
