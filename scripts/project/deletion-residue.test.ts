// @vitest-environment node
//
// The residue instruments, held to the graph they derive from.
//
// WHAT THESE TESTS ARE FOR. The instruments exist to disagree with the procedure. If they share its
// mistakes they confirm it instead, and a green residue report reads as a clean deletion. So the
// assertions below are about the DERIVATION: that the walk reaches what it should, that the join it
// writes points outwards from `users` rather than inwards, and that the sweep searches the columns
// that can hold a literal. None of them needs a database — a query that is wrong is wrong before it
// is run.

import { describe, expect, it } from "vitest";
import { cascadeClosure, R2_PREFIXES, schemaForeignKeys, schemaTextColumns } from "./deletion-census";
import {
  attributionChains,
  attributionPath,
  attributionSql,
  objectKeySql,
  sweepSql,
  type Attribution,
} from "./deletion-residue";

describe("the attribution walk", () => {
  it("starts at the named root with an empty path", () => {
    const root = attributionChains().find((entry) => entry.table === "users");

    expect(root).toEqual({ table: "users", root: "users", path: [] });
  });

  it("walks outwards from the root, so every step's parent is the step before it", () => {
    for (const attribution of attributionChains()) {
      let parent = attribution.root;

      for (const step of attribution.path) {
        expect(step.parentTable, `${attributionPath(attribution)} is not contiguous`).toBe(parent);
        parent = step.table;
      }

      // The last hop IS the table being counted, or the chain describes a different table.
      expect(parent, `${attributionPath(attribution)} ends somewhere else`).toBe(attribution.table);
    }
  });

  it("follows an edge in the direction that makes it reachable, not the direction it is written", () => {
    // `accounts.user_id -> users` is the schema's spelling. The walk has to read it as "users
    // reaches accounts", which is the opposite direction, and getting it backwards would enumerate
    // precisely the wrong tables while looking plausible.
    const accounts = attributionChains().find((entry) => entry.table === "accounts");

    expect(accounts?.path.map((step) => step.table)).toEqual(["accounts"]);
    expect(accounts?.path[0]?.parentTable).toBe("users");
  });

  it("reaches a table through a chain, not only through a direct foreign key", () => {
    // `competition_results` has no edge to `users` at all. It is reachable because
    // `competition_registrations` is, and a walk that only read direct edges would miss it and
    // report nothing surviving it.
    const results = attributionChains().find((entry) => entry.table === "competition_results");

    expect(results?.path.length).toBeGreaterThan(1);
    expect(results?.path.at(-1)?.table).toBe("competition_results");
  });

  it("gives each table the shortest chain, so a count is not read off a longer route", () => {
    // The property a breadth-first walk is chosen for: a table's distance is one more than the
    // nearest table it references. A depth-first walk would satisfy "reachable" and violate this,
    // and the join it wrote would be longer than the one the graph requires.
    const keys = schemaForeignKeys();
    const chains = attributionChains("users", keys);
    const distance = new Map(chains.map((entry) => [entry.table, entry.path.length]));

    for (const attribution of chains) {
      if (attribution.table === "users") continue;

      const nearest = Math.min(
        ...keys
          .filter((key) => key.sourceTable === attribution.table)
          .map((key) => 1 + (distance.get(key.targetTable) ?? Number.POSITIVE_INFINITY)),
      );

      expect(attribution.path.length, `${attribution.table} was reached the long way round`).toBe(
        nearest,
      );
    }
  });

  it("refuses to run off the end of a chain that does not exist", () => {
    // The walk's population is whatever the schema declares. A root nothing references yields only
    // itself, which is the shape that would silently produce a report of nothing.
    expect(attributionChains("a_root_nothing_points_at", schemaForeignKeys())).toEqual([
      { table: "a_root_nothing_points_at", root: "a_root_nothing_points_at", path: [] },
    ]);
  });

  it("can be narrowed to one referential action, so a chain says which rows the deletion takes", () => {
    // Narrowing is the difference between two questions: "which rows mention this person" and "which
    // rows does the deletion remove". Only the second is answerable by a join through a column that
    // the deletion NULLs.
    const all = attributionChains();
    const cascading = attributionChains("users", schemaForeignKeys(), ["cascade"]);

    expect(cascading.length).toBeLessThan(all.length);
    expect(cascading.map((entry) => entry.table).sort()).toEqual(cascadeClosure());
  });

  it("reaches a document a candidate uploaded through their registration, not the organiser", () => {
    // THE DEFECT THIS PINS. `competition_document_request_files.r2_key` is an object key the deletion
    // must remove, because the row carrying it is inside the closure. The unrestricted walk reaches
    // that table in two hops, through `competition_document_requests.requested_by_user_id` — the
    // organiser who ASKED for the document, on a column the deletion sets to null. A count built
    // from that chain returns zero for every candidate who uploaded anything, and reports it as an
    // account with no documents.
    const cascading = attributionChains("users", schemaForeignKeys(), ["cascade"]);
    const files = cascading.find((entry) => entry.table === "competition_document_request_files");

    expect(attributionPath(files as Attribution)).toBe(
      "users -> competition_registrations -> competition_document_requests -> competition_document_request_files",
    );
  });
});

describe("the object-key walk", () => {
  const cascades = schemaForeignKeys().filter((key) => key.onDelete === "cascade");

  it("uses only CASCADE edges, so every column in a join is on a row the deletion removes", () => {
    const keys = schemaForeignKeys();

    expect(cascades.length).toBeGreaterThan(0);
    expect(objectKeySql().length).toBeGreaterThan(0);

    for (const entry of objectKeySql()) {
      const chain = attributionChains("users", keys, ["cascade"]).find(
        (candidate) => candidate.table === entry.column.slice(0, entry.column.lastIndexOf(".")),
      );

      expect(chain, `${entry.column} is not reachable along CASCADE edges`).toBeDefined();

      for (const step of chain!.path) {
        const edge = cascades.find(
          (key) =>
            key.sourceTable === step.table &&
            key.targetTable === step.parentTable &&
            key.sourceColumns.join("+") === step.columns.join("+"),
        );
        expect(edge, `${attributionPath(chain!)} follows a non-CASCADE edge`).toBeDefined();
      }
    }
  });

  it("builds each join from the chain the deletion walks, not from the shortest one that exists", () => {
    // THE ASSERTION THE `["cascade"]` RESTRICTION FAILS, and it did not exist until a Rule 36 probe
    // measured it: with the argument dropped from `objectKeySql`, every test in this file still
    // passed. The check above asks whether a CASCADE chain EXISTS for each column, and one always
    // does, so it stays green while the query underneath becomes a different one. Presence was not
    // enforcement, and the probe is what said so.
    //
    // The worked case is the document a candidate uploaded. Unrestricted, the shortest chain to
    // `competition_document_request_files` runs through the organiser who ASKED for it, on a column
    // the deletion sets to null — so the count answers zero for every candidate who uploaded one and
    // reports it as an account holding no files.
    const keys = schemaForeignKeys();
    const cascading = attributionChains("users", keys, ["cascade"]);
    const counted = objectKeySql();

    // A tripwire so the loop below cannot pass over an empty population.
    expect(counted.length).toBeGreaterThan(0);

    for (const entry of counted) {
      const separator = entry.column.lastIndexOf(".");
      const table = entry.column.slice(0, separator);
      const column = entry.column.slice(separator + 1);
      const chain = cascading.find((candidate) => candidate.table === table);

      expect(chain, `${entry.column} is not reachable along CASCADE edges`).toBeDefined();
      expect(entry.sql, `${entry.column} is counted through a chain the deletion does not walk`).toBe(
        attributionSql(chain as Attribution, column),
      );
    }

    // And the specific case, named, so a failure here reads as the defect rather than as a diff.
    const documents = counted.find((entry) =>
      entry.column.startsWith("competition_document_request_files."),
    );

    expect(documents?.sql).toContain("join competition_registrations t1 on");
  });

  it("counts only rows that actually hold a key, so a null is not reported as an object", () => {
    // Without the predicate the count is the number of rows, and a candidate with a profile and no
    // avatar would be reported as holding an avatar object that no bucket contains.
    for (const entry of objectKeySql()) {
      expect(entry.sql).toContain("is not null");
    }
  });

  it("counts one key column per prefix a deletion removes, so no key is left unread", () => {
    const reached = R2_PREFIXES.filter((entry) => entry.reachedByDeletion);
    const counted = objectKeySql();

    for (const prefix of reached) {
      const arms = counted.filter((entry) => entry.prefix === prefix.prefix);
      expect(arms.length, `\`${prefix.prefix}\` has ${arms.length} key columns counted`).toBe(
        prefix.keyColumns.length,
      );
    }
  });
});

describe("the attribution join", () => {
  const chains = attributionChains();
  const byTable = (table: string): Attribution =>
    chains.find((entry) => entry.table === table) as Attribution;

  it("counts from the root, so the user id is the row the join starts at", () => {
    const sql = attributionSql(byTable("accounts"));

    expect(sql).toContain("from users t0");
    expect(sql).toContain("where t0.id = $1");
  });

  it("pairs each hop's columns with its PARENT's, not with its own", () => {
    // The defect this catches: writing `t1.user_id = t1.id`, which is satisfied by nothing, and
    // writing `t1.id = t0.user_id`, which reads as a join and is a different query.
    const sql = attributionSql(byTable("accounts"));

    expect(sql).toContain("join accounts t1 on t1.user_id = t0.id");
  });

  it("numbers the aliases in path order, so a longer chain joins end to end", () => {
    const sql = attributionSql(byTable("competition_results"));
    const path = byTable("competition_results").path;

    path.forEach((step, index) => {
      expect(sql, `hop ${index} is missing`).toContain(`join ${step.table} t${index + 1} on`);
    });
    expect(sql).toContain(`t${path.length}.`);
  });

  it("renders the chain as a reader sees it, so a count can be audited", () => {
    expect(attributionPath(byTable("accounts"))).toBe("users -> accounts");
    expect(attributionPath(byTable("users"))).toBe("users");
  });
});

describe("the value sweep", () => {
  it("searches a column as text, so an enum does not fail the whole query", () => {
    // An enum type has no `ilike` operator. Without the cast the sweep dies on the first enum
    // column it reaches, and a sweep that threw is a sweep whose result nobody has.
    expect(sweepSql([{ table: "candidate_profiles", column: "occupation" }])).toContain(
      "occupation::text ilike",
    );
  });

  it("matches a substring, so a value inside a blob is found and not only one alone in a column", () => {
    const sql = sweepSql([{ table: "users", column: "email" }]);

    expect(sql).toContain("ilike '%' ||");
    expect(sql).toContain("|| '%'");
  });

  it("neutralises the pattern's own metacharacters, so a hit is at a column holding the literal", () => {
    // THE DEFECT THIS PINS, measured against the live database. `_` is a single-character wildcard
    // inside a LIKE pattern, and every value swept for is one of the person's own strings — the seed
    // matrix's usernames are spelled with underscores. Interpolated raw, the pattern for
    // `seed_rec_min` matched the institution slug `seed-rec-min`, the hyphen standing in for the
    // underscore, and the report named `institutions.slug` as the location. That column does not
    // contain the literal: `ilike '%seed_rec_min%'` matches 1 row and `slug = 'seed_rec_min'`
    // matches 0. The row the report named was real residue reached by accident, and the reader was
    // told a reason that was not the reason.
    const sql = sweepSql([{ table: "users", column: "email" }]);

    // One assertion rather than three, because the ORDER is as load bearing as the content and only
    // the whole expression pins it: the backslash replace must be innermost, or it re-escapes the
    // backslashes the two wildcard replaces insert and every pattern searches for a literal
    // backslash that no row contains.
    expect(sql).toContain("replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
  });

  it("reports where each hit was, so a count without a location cannot be read as clean", () => {
    expect(sweepSql([{ table: "users", column: "email" }])).toContain(
      "select 'users.email' as location",
    );
  });

  it("refuses an empty population rather than returning a query matching nothing", () => {
    expect(() => sweepSql([])).toThrow(/no columns to search/);
  });

  it("searches every column that can hold a literal, and refuses one it cannot classify", () => {
    const targets = schemaTextColumns();

    // A tripwire so the two assertions below cannot pass over an empty population.
    expect(targets.length).toBeGreaterThan(100);

    // The column the detached-invitation residue sits in, and the two the demonstration turns on.
    const columns = targets.map((target) => `${target.table}.${target.column}`);

    expect(columns).toContain("institution_invitations.invited_email");
    expect(columns).toContain("users.email");
    expect(columns).toContain("users.username");
    expect(columns).toContain("candidate_profiles.full_name");

    // A timestamp cannot hold a person's address, so sweeping it would add cost and no evidence.
    expect(columns).not.toContain("users.created_at");
  });
});
