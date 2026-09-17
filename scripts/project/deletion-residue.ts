/**
 * What a hand deletion left behind, measured without asking the deletion.
 *
 * A procedure that checks its own work is checking the same understanding twice. Every statement in
 * `docs/operations/account-deletion-procedure.md` is written by hand, from what its author believed
 * about the schema; if that belief is wrong the procedure reports success and the residue is
 * invisible. This module is the other reader: it DERIVES its queries from the foreign-key graph and
 * from the schema's own column list, and shares no SQL with the procedure at all.
 *
 * TWO INSTRUMENTS, BECAUSE EACH IS BLIND TO A DIFFERENT RESIDUE.
 *
 *   1. ATTRIBUTION. For every table reachable from `users` along foreign keys, count the rows still
 *      joined to the deleted user's id. This catches anything the delete missed in the graph.
 *
 *      It is BLIND to a detached row. Deleting a user nulls `institution_invitations.target_user_id`,
 *      so the invitation stops being attributable to them and this count reports zero while the row
 *      — and the email address on it — is still there.
 *
 *   2. VALUE SWEEP. For every text column of every table, count the rows containing one of the
 *      deleted user's own strings. This catches the detached rows the first instrument cannot see,
 *      and any denormalised copy nobody modelled as a reference.
 *
 *      It is blind to a residue that is neither attributable nor literally present: an R2 object, a
 *      search document, a job payload. Those are not in this database, and no query here reaches
 *      them.
 *
 * Neither instrument being red is evidence of a clean deletion. Both being green is evidence of a
 * deletion that left behind nothing THIS DATABASE can see, which is a smaller claim and the true
 * one.
 *
 * THREE MODES. The first answers "what is attributable to this account right now".
 *
 *   node --import tsx scripts/project/deletion-residue.ts <userId>
 *
 * The other two exist because a verifier that reads its questions after the deletion is answering a
 * question about a different database. `capture` takes this instrument's own before-picture, and
 * `verify` re-runs exactly that picture afterwards.
 *
 *   node --import tsx scripts/project/deletion-residue.ts capture --user <userId> --out <file>
 *   node --import tsx scripts/project/deletion-residue.ts verify --baseline <file> --out <file>
 *
 * This module only reads. It deletes nothing, so it carries no host restriction, and every statement
 * it issues is a `select`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadEnvFile } from "@/server/scripts/env-file";
import {
  R2_PREFIXES,
  schemaForeignKeys,
  schemaTextColumns,
  schemaTableNames,
} from "./deletion-census";
import type { ReferentialAction } from "./deletion-census";

/** One hop of a join from `users` to a table that carries rows about a user. */
export type AttributionStep = {
  table: string;
  columns: readonly string[];
  parentTable: string;
  parentColumns: readonly string[];
};

/** How one table's rows are reached from a `users` row. */
export type Attribution = {
  /** The table being counted. */
  table: string;
  /** The table the walk started from. Every join is written outwards from this one. */
  root: string;
  /** The join chain, from the root outwards. Empty when `table` IS the root. */
  path: readonly AttributionStep[];
};

/**
 * Every table reachable from `users`, with the shortest foreign-key chain that gets there.
 *
 * Breadth first, so the path a table gets is the shortest one and the generated join cannot grow a
 * spurious duplicate through a longer route. `users` itself is the root and has the empty path.
 *
 * The walk follows EVERY referential action by default, not only CASCADE. A detached or blocking
 * table is exactly where residue lives, and a walk that skipped those edges would report a clean
 * database for the tables most likely to hold something.
 *
 * `onDelete` narrows the walk to the named actions. That filter changes the question the chain
 * answers: the unrestricted walk asks "which rows mention this person", while a walk restricted to
 * `cascade` asks "which rows does the deletion take with it". The two differ at exactly the tables
 * that survive, and a chain chosen for the first question is a wrong route to the second — it joins
 * through a pointer the deletion NULLs, so it counts another person's rows as this one's and finds
 * nothing where this one's rows are.
 */
export const attributionChains = (
  from = "users",
  keys = schemaForeignKeys(),
  onDelete?: readonly ReferentialAction[],
): Attribution[] => {
  const followed =
    onDelete === undefined ? keys : keys.filter((key) => onDelete.includes(key.onDelete));
  const paths = new Map<string, readonly AttributionStep[]>([[from, []]]);
  const reachable: Attribution[] = [{ table: from, root: from, path: [] }];
  let frontier = [from];

  while (frontier.length > 0) {
    const next: string[] = [];

    for (const parent of frontier) {
      const parentPath = paths.get(parent)!;

      for (const key of followed) {
        if (key.targetTable !== parent || paths.has(key.sourceTable)) continue;

        const step: AttributionStep = {
          table: key.sourceTable,
          columns: key.sourceColumns,
          parentTable: parent,
          parentColumns: key.targetColumns,
        };
        paths.set(key.sourceTable, [...parentPath, step]);
        reachable.push({ table: key.sourceTable, root: from, path: [...parentPath, step] });
        next.push(key.sourceTable);
      }
    }

    frontier = next;
  }

  return reachable;
};

/** The join chain as a reader sees it, so a count can be audited without reading the SQL. */
export const attributionPath = (attribution: Attribution): string =>
  [attribution.root, ...attribution.path.map((step) => step.table)].join(" -> ");

/**
 * The SQL that counts one table's rows attributable to a user, as a join outwards from the root.
 *
 * The root is `t0` and each hop is `t1`, `t2`, … in path order, so a step's condition always pairs
 * its own columns with its parent's. Aliases are positional rather than the table's own name because
 * the same table can appear twice in one chain — a self-referencing foreign key would otherwise
 * produce `join x on x.a = x.b`, which is satisfied by every row.
 */
export const attributionSql = (attribution: Attribution, notNull?: string): string => {
  const lines = ["select count(*)::int as n", `from ${attribution.root} t0`];

  attribution.path.forEach((step, index) => {
    const condition = step.columns
      .map(
        (column, position) => `t${index + 1}.${column} = t${index}.${step.parentColumns[position]}`,
      )
      .join(" and ");
    lines.push(`join ${step.table} t${index + 1} on ${condition}`);
  });

  lines.push("where t0.id = $1");
  // The optional predicate counts only the rows that actually hold a value, which is what an object
  // key count means. Without it the count would include rows whose key is null and overstate how
  // much there is to remove.
  if (notNull !== undefined) {
    lines.push(`and t${attribution.path.length}.${notNull} is not null`);
  }
  return lines.join("\n");
};

/**
 * How many R2 object keys this account actually has, per prefix, derived from the graph.
 *
 * This is the measure the procedure's capture step is held against, and it is deliberately NOT the
 * procedure's query: the joins come from the foreign-key walk and the columns from the census's
 * declared key columns, which is a different route to the same count. When one step is removed and
 * the two disagree, the disagreement is the residue.
 *
 * A prefix whose key column lives on a table the walk cannot reach is skipped rather than counted as
 * zero, because zero and unreachable are the same number and opposite facts.
 *
 * The walk is restricted to CASCADE edges, and that restriction is load bearing. An object key is a
 * thing the deletion has to remove, so the row carrying it has to be a row the deletion removes. A
 * key column on a table reached through a `set null` edge belongs to a row that survives with its
 * pointer cleared — `competition_document_requests.requested_by_user_id` is the worked example. A
 * chain through it joins the organiser who asked for a document, and answers a count of zero for
 * every candidate who uploaded one.
 */
export const objectKeySql = (): { prefix: string; column: string; sql: string }[] => {
  const chains = attributionChains("users", schemaForeignKeys(), ["cascade"]);
  const counted: { prefix: string; column: string; sql: string }[] = [];

  for (const entry of R2_PREFIXES) {
    if (!entry.reachedByDeletion) continue;

    for (const keyColumn of entry.keyColumns) {
      const separator = keyColumn.lastIndexOf(".");
      const table = keyColumn.slice(0, separator);
      const column = keyColumn.slice(separator + 1);
      const chain = chains.find((candidate) => candidate.table === table);
      if (chain === undefined) continue;

      counted.push({ prefix: entry.prefix, column: keyColumn, sql: attributionSql(chain, column) });
    }
  }

  return counted;
};

/** One text column, addressed for a sweep. */
export type SweepTarget = { table: string; column: string };

/**
 * `$1` rendered as a LIKE pattern, with the pattern's own metacharacters neutralised.
 *
 * THE DEFECT THIS EXISTS FOR. `_` and `%` are wildcards inside a LIKE pattern, and the values this
 * sweeps for are a person's own strings — a username like `seed_rec_min` contains one. Interpolated
 * raw, that pattern matches `seed-rec-min`, the hyphen standing in for the underscore, and the sweep
 * then reports a hit at a location that does not contain the literal at all. The hit is worse than a
 * miss: it is real residue, reached by accident, reported under a location that misattributes it, so
 * the reader cannot tell which store actually holds what and neither can a follow-up query.
 *
 * The backslash replacement is innermost so that it runs first. Escaping in the other order would
 * re-escape the backslashes the later replacements insert, and every pattern would then search for a
 * literal backslash that no row contains.
 */
const LIKE_LITERAL = "replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_')";

/**
 * A single `union all` counting, per text column, the rows containing `$1` as a substring.
 *
 * Substring rather than equality: an address is as likely to be embedded in a JSON blob or a
 * composed display string as it is to sit alone in a column of its own, and an equality sweep would
 * miss every one of those and report the row clean.
 *
 * Every column is cast to `text` before matching. An enum has no `ilike` of its own, so without the
 * cast the whole sweep fails on the first enum column it meets — and a sweep that throws is a sweep
 * whose result nobody has.
 */
export const sweepSql = (targets: readonly SweepTarget[]): string => {
  if (targets.length === 0) throw new Error("the sweep has no columns to search");

  return targets
    .map(
      (target) =>
        `select '${target.table}.${target.column}' as location, count(*)::int as n ` +
        `from ${target.table} where ${target.column}::text ilike '%' || ${LIKE_LITERAL} || '%'`,
    )
    .join("\nunion all\n");
};

/**
 * A baseline this instrument captured for itself, before anything was deleted.
 *
 * The point of capturing it here rather than accepting the procedure's capture step as input is
 * that the two are different readers. The procedure reads the strings it was written to read; this
 * reads the strings the rows hold. A mistake in the first is invisible to the first and caught by
 * the second, and it is caught only if the second's copy was taken before the rows went away.
 */
export type ResidueBaseline = {
  userId: string;
  capturedAt: string;
  /** Tables the schema declares, so a later run can tell a changed schema from a changed result. */
  tables: number;
  /** Tables reachable from `users` along foreign keys, one entry per join this instrument will run. */
  reachableFrom: number;
  /** The account's own strings, read from the live rows. */
  literals: string[];
  /** Every attribution join, with the count it returned before the deletion. */
  attribution: { path: string; sql: string; expected: number }[];
};

/** A baseline file this instrument cannot use. Refused by name rather than half-read. */
export class ResidueRefusal extends Error {}

const connect = (): postgres.Sql => {
  const { loadedFrom } = loadEnvFile({});
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new ResidueRefusal(
      `DATABASE_URL is not set and no env file was found (candidates: ${loadedFrom})`,
    );
  }
  return postgres(url, { max: 1 });
};

/**
 * The account's own strings, read from the live rows.
 *
 * Read rather than passed on the command line, because a literal typed by the operator is a literal
 * the operator already knew to look for, and the residue that matters is the one nobody remembered
 * to write down.
 *
 * THE POPULATION IS WHOLE VALUES, and that boundary is a decision this instrument does not make.
 * The four columns below hold the account's own strings; a surviving row that renders the person
 * under some other string is outside the sweep and reports as zero. A personal institution is the
 * worked case: its `description` reads `Institusi personal milik Rina (data uji).` and the
 * competition the person authored is titled `Kuis Mingguan Rina`, and neither contains the username
 * `seed_rec_min`. Splitting a stored name into its parts would widen the search, and by how much is
 * a product decision about what counts as identifying — a scope boundary this phase has no ruling
 * for, so the boundary is stated here instead of guessed at in code.
 *
 * THESE FOUR ARE NARROWER THAN THE PROCEDURE'S OWN CAPTURE, which reads eight columns. `users.name`,
 * `user_profiles.display_name` and `user_profiles.phone_number` are not read here, so an account
 * with no `candidate_profiles` row — every recruiter — is swept on its email and username alone.
 * That gap is inside the boundary described above rather than a question about where the boundary
 * sits, and it is recorded in the register rather than closed here.
 */
export const readIdentities = async (sql: postgres.Sql, userId: string): Promise<string[]> => {
  const rows = await sql<
    {
      email: string | null;
      username: string | null;
      full_name: string | null;
      phone_number: string | null;
    }[]
  >`
    select u.email, u.username, p.full_name, p.phone_number
    from users u left join candidate_profiles p on p.user_id = u.id
    where u.id = ${userId}
  `;

  return [
    ...new Set(
      (rows[0] === undefined ? [] : Object.values(rows[0])).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
};

/** Read every attribution count and the account's own strings, before anything is deleted. */
export const captureBaseline = async (
  sql: postgres.Sql,
  userId: string,
): Promise<ResidueBaseline> => {
  const [exists] = await sql<{ n: number }[]>`
    select count(*)::int as n from users where id = ${userId}
  `;
  if (exists!.n === 0) {
    throw new ResidueRefusal(
      `no row in users for ${userId}, so there is nothing to capture a baseline from`,
    );
  }

  const literals = await readIdentities(sql, userId);
  if (literals.length === 0) {
    throw new ResidueRefusal(
      `the account ${userId} has no string to sweep for, so this instrument could not report a ` +
        "residue even if one existed. Refusing rather than capturing a baseline that cannot fail",
    );
  }

  const attribution: ResidueBaseline["attribution"] = [];
  for (const chain of attributionChains()) {
    const statement = attributionSql(chain);
    const [row] = await sql.unsafe<{ n: number }[]>(statement, [userId]);
    attribution.push({ path: attributionPath(chain), sql: statement, expected: row!.n });
  }

  return {
    userId,
    capturedAt: new Date().toISOString(),
    tables: schemaTableNames().length,
    reachableFrom: attribution.length,
    literals,
    attribution,
  };
};

export type ResidueReport = {
  baseline: ResidueBaseline;
  /** The `users` row itself. False after a deletion that completed. */
  userRowRemains: boolean;
  attribution: { path: string; expected: number; remaining: number }[];
  sweep: { literal: string; locations: { location: string; n: number }[] }[];
  /** Columns the sweep searched, so a shrinking sweep is visible rather than merely quiet. */
  sweepColumns: number;
  tables: number;
};

/**
 * Re-run the baseline's own queries and report what is still there.
 *
 * The joins and the literals both come from the baseline, which is the instrument's own earlier
 * read. Nothing here is re-derived and nothing is taken from the procedure: a check that reloads its
 * questions from a live source after the deletion is answering a question asked about a different
 * database, and the answers would agree for exactly that reason.
 */
export const verifyBaseline = async (
  sql: postgres.Sql,
  baseline: ResidueBaseline,
): Promise<ResidueReport> => {
  const [user] = await sql<{ n: number }[]>`
    select count(*)::int as n from users where id = ${baseline.userId}
  `;

  const attribution: ResidueReport["attribution"] = [];
  for (const entry of baseline.attribution) {
    const [row] = await sql.unsafe<{ n: number }[]>(entry.sql, [baseline.userId]);
    attribution.push({ path: entry.path, expected: entry.expected, remaining: row!.n });
  }

  const targets = schemaTextColumns();
  const sweep: ResidueReport["sweep"] = [];
  for (const literal of baseline.literals) {
    const rows = await sql.unsafe<{ location: string; n: number }[]>(sweepSql(targets), [literal]);
    sweep.push({ literal, locations: rows.filter((row) => row.n > 0) });
  }

  return {
    baseline,
    userRowRemains: user!.n > 0,
    attribution,
    sweep,
    sweepColumns: targets.length,
    tables: schemaTableNames().length,
  };
};

/** One or more baselines, as the file on disk holds them. */
export type BaselineFile = {
  generatedAt: string;
  cases: { label: string; baseline: ResidueBaseline }[];
};

const asBaseline = (value: unknown, where: string): ResidueBaseline => {
  const record = value as Partial<ResidueBaseline>;
  const missing = (["userId", "literals", "attribution"] as const).filter(
    (field) => record[field] === undefined,
  );
  if (missing.length > 0) {
    throw new ResidueRefusal(`${where} is not a residue baseline: it has no ${missing.join(", ")}`);
  }
  if (!Array.isArray(record.literals) || !Array.isArray(record.attribution)) {
    throw new ResidueRefusal(`${where} has a \`literals\` or \`attribution\` that is not a list`);
  }

  return record as ResidueBaseline;
};

/** Refuse a baseline file that is not one, rather than reading whatever fields happen to be there. */
export const parseBaselineFile = (raw: string, path: string): BaselineFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ResidueRefusal(`${path} is not JSON: ${(error as Error).message}`);
  }

  const record = parsed as Partial<BaselineFile>;
  if (Array.isArray(record.cases)) {
    return {
      generatedAt: record.generatedAt ?? "unrecorded",
      cases: record.cases.map((entry, index) => ({
        label: entry.label ?? `case ${index + 1}`,
        baseline: asBaseline(entry.baseline, `${path} case ${index + 1}`),
      })),
    };
  }

  const single = parsed as Partial<ResidueBaseline>;
  if (single.userId !== undefined) {
    return {
      generatedAt: single.capturedAt ?? "unrecorded",
      cases: [{ label: "the account", baseline: asBaseline(single, path) }],
    };
  }

  throw new ResidueRefusal(`${path} holds neither a baseline nor a list of them`);
};

/** One case's verification, as a section of the document. */
const renderCaseVerification = (label: string, report: ResidueReport): string[] => {
  const { baseline } = report;
  const remaining = report.attribution.reduce((total, entry) => total + entry.remaining, 0);
  const carried = report.sweep.reduce((total, entry) => total + entry.locations.length, 0);
  const expected = report.attribution.reduce((total, entry) => total + entry.expected, 0);

  const lines: string[] = [
    `## ${label}`,
    "",
    `Account \`${baseline.userId}\`, baseline captured \`${baseline.capturedAt}\` — **before** the procedure ran.`,
    "",
    report.userRowRemains
      ? "**A row for this id still exists in `users`.** The deletion did not complete, so nothing below is a residue of a deletion — what is measured is the account, intact."
      : "**No row for this id remains in `users`.** The deletion removed the account row itself.",
    "",
    `Rows attributable before the deletion: **${expected}**. After: **${remaining}**.`,
    `Text columns searched: **${report.sweepColumns}**, against **${baseline.literals.length}** literal(s). Columns carrying one: **${carried}**.`,
    "",
    "A literal is one of the account's own stored values, **whole**: its email address, its username,",
    "the full name on its candidate profile, its phone number. The sweep matches each of those",
    "strings as a substring anywhere in any text column, and nothing else. So a zero below is a",
    "statement about these strings and not about the person: a residue that presents them under any",
    "other string — a given name inside a longer title, an initial, a handle the account never",
    "stored — is outside the population this instrument searches, and is reported as zero.",
    "",
    "| attribution path | before | after |",
    "| --- | --- | --- |",
    ...report.attribution.map(
      (entry) => `| \`${entry.path}\` | ${entry.expected} | ${entry.remaining} |`,
    ),
    "",
  ];

  if (remaining === 0) {
    lines.push(
      "Every count is zero. Nothing this instrument can join to the account survived the deletion.",
      "",
    );
  } else {
    lines.push("A non-zero `after` is a row the deletion did not reach.", "");
  }

  for (const entry of report.sweep) {
    lines.push(`### \`${entry.literal}\``, "");
    if (entry.locations.length === 0) {
      lines.push("No column in the database contains this string.", "");
      continue;
    }
    lines.push("| rows | location |", "| --- | --- |");
    for (const location of entry.locations) {
      lines.push(`| ${location.n} | \`${location.location}\` |`);
    }
    lines.push("");
  }

  return lines;
};

/** The verification, as a document. Every line of it is written here. */
export const renderVerification = (
  entries: readonly { label: string; report: ResidueReport }[],
): string => {
  const first = entries[0]!.report;

  const lines: string[] = [
    "# Account deletion — what the independent verifier found",
    "",
    "**This file is generated. Do not edit it.**",
    "",
    "    node --import tsx scripts/project/deletion-residue.ts verify --baseline <file> --out <this file>",
    "",
    "Every line below is written by `scripts/project/deletion-residue.ts`. It shares no SQL with",
    "`docs/operations/account-deletion-procedure.md`: its joins are derived from the foreign-key",
    "graph and its search list from the schema's own text columns.",
    "",
    "**Sharing no SQL is not the same as sharing no assumption.** The two readers agree on the",
    "foreign-key graph — the procedure deletes along it and this verifier counts along it — so a",
    "store the graph does not model is invisible to both, and LAUNCH-D100 is that case: `institutions`",
    "declares no FK to `users`, so a recruiter's deletion leaves institutions and published",
    "competitions standing while this file reports zero. The graph is the deeper coupling, and the",
    "zeros below are only as good as it is.",
    "",
    "## Read this before reading the result",
    "",
    "Two instruments ran, and each is blind to a different residue.",
    "",
    "- **Attribution** follows every foreign key outwards from `users` and counts the rows still",
    "  joined to the deleted account. It is blind to a detached row: deleting a user nulls",
    "  `institution_invitations.target_user_id`, so the invitation stops being attributable and this",
    "  count reads zero while the row, and the email address on it, is still there.",
    "- **Value sweep** searches every text column of every table for the account's own strings. It",
    "  catches the detached rows the first instrument cannot, and any denormalised copy nobody",
    "  modelled as a reference. It is blind to anything outside this database — an R2 object, a",
    "  search document, a job payload — and no query here reaches those.",
    "",
    "Neither instrument being red is evidence of a clean deletion. Both being green is evidence of a",
    "deletion that left nothing behind THAT THIS DATABASE CAN SEE, which is a smaller claim and the",
    "true one.",
    "",
    "The literals and the joins both come from a baseline this instrument captured for ITSELF, from",
    "the live rows, before anything was deleted — not from the procedure's own capture step. That is",
    "what makes this a check rather than a restatement: two readers, one database, asked",
    "independently what is in it. A verifier that reloads its questions after the deletion is",
    "answering a question about a different database.",
    "",
    `Baselines verified: **${entries.length}**, taken \`${first.baseline.capturedAt}\`.`,
    "",
  ];

  for (const entry of entries) lines.push(...renderCaseVerification(entry.label, entry.report));

  lines.push(
    "## What this does not cover",
    "",
    "Cloudflare R2. Meilisearch. Redis. BullMQ. Resend. Sentry. None of them is in this database,",
    "and no query in this file reaches any of them. A green result here is a statement about",
    "Postgres and about nothing else — the bytes in a bucket are not visible to it, and the",
    "procedure's own removal step for those was named and not executed.",
    "",
    `${first.baseline.tables} tables in the baseline's schema, ${first.tables} now. A change there`,
    "means the schema moved between the capture and the check.",
    "",
  );

  return lines.join("\n");
};

/** The standalone report: no baseline, both instruments run against the live database. */
const reportLive = async (sql: postgres.Sql, userId: string): Promise<string> => {
  const literals = await readIdentities(sql, userId);
  const lines: string[] = [`# Residue for \`${userId}\``, ""];

  if (literals.length === 0) {
    lines.push(
      "`users` holds no row for this id, so this instrument has no string to sweep for. Its",
      "silence is NOT a clean result.",
      "",
    );
  }

  lines.push("## Attribution", "");
  const chains = attributionChains();
  let attributed = 0;

  for (const chain of chains) {
    const [row] = await sql.unsafe<{ n: number }[]>(attributionSql(chain), [userId]);
    if (row!.n > 0) {
      attributed += row!.n;
      lines.push(`- ${row!.n} — \`${attributionPath(chain)}\``);
    }
  }
  lines.push(
    "",
    attributed === 0
      ? "Nothing is attributable to this id."
      : `**${attributed}** row(s) attributable to this id.`,
    "",
    "## Value sweep",
    "",
  );

  const targets = schemaTextColumns();
  for (const literal of literals) {
    const rows = await sql.unsafe<{ location: string; n: number }[]>(sweepSql(targets), [literal]);
    const hits = rows.filter((row) => row.n > 0);
    lines.push(`- \`${literal}\` — ${hits.length} column(s) carry it`);
    for (const hit of hits) lines.push(`  - ${hit.n} in \`${hit.location}\``);
  }

  lines.push(
    "",
    `${schemaTableNames().length} tables, ${chains.length} reachable from \`users\`.`,
    "",
  );

  return lines.join("\n");
};

const flag = (argv: readonly string[], name: string): string | null => {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined) throw new ResidueRefusal(`${name} needs a value`);
  return value;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const out = flag(argv, "--out");
  const sql = connect();

  const emit = (text: string): void => {
    if (out === null) {
      console.log(text);
      return;
    }
    writeFileSync(resolve(process.cwd(), out), `${text}\n`, "utf8");
    console.log(`wrote ${out}`);
  };

  try {
    if (command === "capture") {
      const userId = flag(argv, "--user");
      if (userId === null) throw new ResidueRefusal("capture needs --user <userId>");
      const baseline = await captureBaseline(sql, userId);
      const file: BaselineFile = {
        generatedAt: baseline.capturedAt,
        cases: [{ label: flag(argv, "--label") ?? "the account", baseline }],
      };
      emit(JSON.stringify(file, null, 2));
      return;
    }

    if (command === "verify") {
      const path = flag(argv, "--baseline");
      if (path === null) throw new ResidueRefusal("verify needs --baseline <file>");
      const file = parseBaselineFile(readFileSync(resolve(process.cwd(), path), "utf8"), path);

      const entries: { label: string; report: ResidueReport }[] = [];
      for (const entry of file.cases) {
        entries.push({ label: entry.label, report: await verifyBaseline(sql, entry.baseline) });
      }

      emit(renderVerification(entries));
      return;
    }

    if (command === undefined || command.startsWith("--")) {
      throw new ResidueRefusal(
        "usage: deletion-residue.ts <userId> | capture --user <userId> | verify --baseline <file>",
      );
    }

    emit(await reportLive(sql, command));
  } finally {
    await sql.end();
  }
};

if (process.argv[1]?.endsWith("deletion-residue.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
