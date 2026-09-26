// @vitest-environment node
//
// THE ONE REFUSAL THAT IS AN ABSENCE, measured against a live Postgres.
//
// WHY THIS SUITE IS DB-BACKED. The pre-flight asks a question no reading of the schema module can
// answer: given THESE membership rows, is the subject the last active owner of an institution?
// Every part of that — which rows exist, which role and status they carry, how many owners remain
// after the subject's own rows go — is a property of the data, and the guard is a query. A hand-built
// object could not be its input, and when this file was written the guard's query had never been
// executed against a database at all: its first run found the query selecting a column (`role`) that
// does not exist on `institution_memberships` (`membership_role` is the column), which every unit
// test in the repository had passed over because none of them reached the database. That is Rule
// 33's case, made concrete: the tests that existed proved the function's shape, not its wiring.
//
// THE QUERY LIVES IN THE DOCUMENT NOW, and this suite is the binding on it. `preflight-owners` is a
// step of the procedure — one SQL text, executed by the runner and run by hand by an operator in
// `psql` — so the statement is no longer tied to the schema module at compile time. What keeps it
// honest is the fixture below: it plants memberships through the TS union types, and a rename of
// `institution_owner` or `active` in the enum leaves this suite refusing the wrong rows rather than
// passing quietly.
//
// THROUGH THE PRODUCTION PATH, NOT AROUND IT. Each case calls `runProcedure` — the function the
// runner itself calls — with the DOCUMENT's own parsed `sql` steps, so the input is the procedure
// rather than a statement list written here. A case that refused has therefore refused the
// procedure the operator runs, not a paraphrase of it.
//
// WHAT EACH ASSERTION IS INDEPENDENT OF, named because a check whose expected value is computed by
// the code under test proves nothing:
//   - The expected refusal lines are computed from WHAT THIS FILE PLANTED (its own specs), not from
//     `institutionsLeftWithoutAnOwner`. The guard's answer is compared against the fixture's
//     declared shape.
//   - The "does not name it" half is a FOURTH institution planted in the same run with a second
//     active owner. It sits in the same query, so a guard that named every institution the subject
//     owns would fail here rather than pass by naming one fewer than the whole table.
//   - The "writes nothing" half is read from `users` and `institution_memberships` after the
//     refusal, and the strongest available form of "before the first write" is a second refusal
//     driven with the PRE-FLIGHT ALONE as the step list: no transaction step is even offered, so a
//     refusal that still arrives cannot have come from one. Its pair drops the pre-flight instead
//     and asserts the run refuses anyway, which is the wiring that stops the step being skipped.
//
// A SECOND BLOCK MEASURES THE COMMAND LINE ITSELF, and lives here for its fixtures. Whether a
// refused run exits non-zero with the refusal on stderr is a property of the same two refusal
// paths, planted the same way; the fixtures and the guarded connection are already here, and
// nothing about a spawned run is measurable without them.
//
// NOTHING HERE TOUCHES A NON-LOCAL HOST, and nothing here reports a personal datum: the fixtures are
// generated rows, the assertions compare ids, slugs and counts, and no email, username or other
// column value is ever put into a message. The connection is refused unless its host is loopback,
// before a byte is sent. (Rule 35) every fixture is torn down in a `finally`, and the teardown
// asserts that what it removed is gone rather than that it ran.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  competitionStatusEnum,
  type CompetitionStatus,
  type InstitutionMembershipRole,
  type InstitutionMembershipStatus,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { isLocalDatabaseHost, parseDatabaseHost } from "../lib/local-database-host";
import {
  PREFLIGHT_STEP_NAME,
  PROCEDURE_PATH,
  PreflightRefusal,
  ProcedureRefusal,
  parseProcedure,
  runProcedure,
  type ProcedureStep,
} from "./run-deletion-procedure";

type Sql = postgres.Sql;

const DATABASE_URL = TEST_DATABASE_URL;

const ACTIVE_OWNER: InstitutionMembershipRole = "institution_owner";
const ACTIVE: InstitutionMembershipStatus = "active";

/**
 * The procedure's own `sql` steps, read once.
 *
 * The document lives in the doc lane (`docs/`, its own private repository under Rule 26), which is
 * gitignored in the product repository, so a checkout without that lane has no procedure here. The
 * lane-absent sentence is repeated from `deletion-procedure.test.ts` rather than imported; that file
 * owns the two-branch discrimination between a missing lane and a missing file, and duplicating it
 * would give the repository two places to keep in step.
 */
const procedureSteps = (): readonly ProcedureStep[] => {
  let markdown: string;
  try {
    markdown = readFileSync(PROCEDURE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    throw new Error(
      `the account-deletion procedure is not readable at ${PROCEDURE_PATH}: the doc lane ` +
        `(\`docs/\`, its own private repository under Rule 26) is not present in this checkout.`,
    );
  }

  return parseProcedure(markdown).filter((step) => step.kind === "sql");
};

// ---------------------------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------------------------

/** One membership planted on an institution, from the point of view of who holds it. */
type MemberSpec = {
  user: "subject" | "co-owner";
  membershipRole: InstitutionMembershipRole;
  status: InstitutionMembershipStatus;
};

/** One institution planted for the subject, and what it holds. */
type InstitutionSpec = {
  /** `personal` institutions may have no `display_name`; the schema check forbids it otherwise. */
  institutionType: "personal" | "company";
  /** Every competition status this institution should hold exactly one row of. */
  competitionStatuses: readonly CompetitionStatus[];
  members: readonly MemberSpec[];
};

/** Everything a case planted, so the assertions and the teardown can both address it by id. */
type Fixture = {
  subject: string;
  coOwner: string;
  institutions: { id: string; slug: string; spec: InstitutionSpec }[];
};

const slugFor = (label: string): string => `pf-${label}-${randomUUID().slice(0, 8)}`;

/** The refusal line the guard prints for one institution, built from the SPEC and not from the query. */
const expectedLine = (institution: { id: string; slug: string; spec: InstitutionSpec }): string => {
  const counts = competitionStatusEnum.enumValues.map((status) => {
    const n = institution.spec.competitionStatuses.filter((held) => held === status).length;
    return `${status}=${n}`;
  });

  return `${institution.slug} (${institution.id}): ${counts.join(" ")}`;
};

const plantFixture = async (
  sql: Sql,
  specs: readonly { label: string; spec: InstitutionSpec }[],
): Promise<Fixture> => {
  const subject = randomUUID();
  const coOwner = randomUUID();
  const users = { subject, "co-owner": coOwner } as const;

  await sql`insert into users (id, email, username, candidate_verified_at)
    values (${subject}, ${`preflight-subject-${subject}@example.test`}, ${`preflight_${subject.slice(0, 8)}`}, now()),
           (${coOwner}, ${`preflight-coowner-${coOwner}@example.test`}, ${`preflight_co_${coOwner.slice(0, 8)}`}, now())`;

  const institutions: Fixture["institutions"] = [];

  for (const { label, spec } of specs) {
    const id = randomUUID();
    const slug = slugFor(label);

    await sql`insert into institutions (id, slug, institution_type, display_name, status)
      values (${id}, ${slug}, ${spec.institutionType}, ${spec.institutionType === "personal" ? null : `Preflight ${label}`}, 'active')`;

    for (const member of spec.members) {
      await sql`insert into institution_memberships (id, institution_id, user_id, membership_role, status)
        values (${randomUUID()}, ${id}, ${users[member.user]}, ${member.membershipRole}, ${member.status})`;
    }

    for (const status of spec.competitionStatuses) {
      await sql`insert into competitions (id, institution_id, slug, title, status)
        values (${randomUUID()}, ${id}, ${`${slug}-${status}`}, ${`Preflight ${label} ${status}`}, ${status})`;
    }

    institutions.push({ id, slug, spec });
  }

  return { subject, coOwner, institutions };
};

/**
 * Remove everything a case planted, then assert it is gone (Rule 35).
 *
 * The assertion is on the tables the fixture WROTE — rows surviving under a fixture id are the
 * failure, and counting by id keeps the check from depending on what else a shared local database
 * happens to hold. Children first: `competitions` and `institution_memberships` both cascade from
 * `institutions`, and both also cascade from `users`, so deleting institutions first would hide a
 * membership that somehow outlived the institution it belongs to.
 */
const removeFixture = async (sql: Sql, fixture: Fixture): Promise<void> => {
  const institutionIds = fixture.institutions.map((institution) => institution.id);
  const userIds = [fixture.subject, fixture.coOwner];

  await sql`delete from competitions where institution_id = any(${institutionIds})`;
  await sql`delete from institution_memberships where institution_id = any(${institutionIds})`;
  await sql`delete from institutions where id = any(${institutionIds})`;
  await sql`delete from users where id = any(${userIds})`;

  const [competitionRows, membershipRows, institutionRows, userRows] = await Promise.all([
    sql<
      { n: number }[]
    >`select count(*)::int as n from competitions where institution_id = any(${institutionIds})`,
    sql<
      { n: number }[]
    >`select count(*)::int as n from institution_memberships where institution_id = any(${institutionIds})`,
    sql<
      { n: number }[]
    >`select count(*)::int as n from institutions where id = any(${institutionIds})`,
    sql<{ n: number }[]>`select count(*)::int as n from users where id = any(${userIds})`,
  ]);

  const competitions = competitionRows[0]?.n ?? 0;
  const memberships = membershipRows[0]?.n ?? 0;
  const institutions = institutionRows[0]?.n ?? 0;
  const users = userRows[0]?.n ?? 0;

  if (competitions + memberships + institutions + users !== 0) {
    throw new Error(
      `the teardown left ${competitions + memberships + institutions + users} fixture row(s) behind ` +
        `(competitions=${competitions} memberships=${memberships} institutions=${institutions} users=${users})`,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// The connection.
// ---------------------------------------------------------------------------------------------

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

afterAll(async () => {
  await client?.end();
});

/**
 * The one connection this suite uses, refused unless it is loopback.
 *
 * Checked at the point of use rather than at import, so the refusal names the host it refused and
 * arrives before the first statement rather than as a module-load stack trace.
 */
const guardedClient = (): Sql => {
  if (!DATABASE_URL) {
    throw new Error("the deletion pre-flight needs a database; this suite should have skipped");
  }

  if (!isLocalDatabaseHost(DATABASE_URL)) {
    throw new Error(
      `refusing to run the deletion pre-flight against ${parseDatabaseHost(DATABASE_URL) ?? "an unparseable host"}: ` +
        "it deletes users, and it may only do that on a loopback database",
    );
  }

  return client as unknown as Sql;
};

/**
 * The client, with every statement the runner issues recorded in the order it issued them.
 *
 * THE PRE-FLIGHT'S CLAIM IS POSITIONAL — it refuses before a transaction is opened — and a refusal
 * that arrives before `begin` leaves no post-state to read afterwards, so the order of the
 * statements is the only evidence of it there is. `runProcedure` reaches the connection through
 * `unsafe` alone, so this forwards that one method; the real client is returned alongside it for
 * the assertions that read rows after the refusal (LAUNCH-D167).
 */
const recordingClient = (sql: Sql): { sql: Sql; statements: string[] } => {
  const statements: string[] = [];

  const recorder = {
    unsafe: (body: string, parameters?: Parameters<Sql["unsafe"]>[1]) => {
      statements.push(body);
      return sql.unsafe(body, parameters);
    },
  };

  return { sql: recorder as unknown as Sql, statements };
};

/** A statement that opens or closes a transaction, which the pre-flight has to precede. */
const OPENS_OR_CLOSES_A_TRANSACTION = /^\s*(begin|commit|rollback)\b/i;

/** What a case observed. */
type Outcome =
  | { kind: "refused"; message: string; steps: string[] }
  | { kind: "ran"; committed: boolean; steps: string[] };

const attemptDeletion = async (
  sql: Sql,
  subject: string,
  steps: readonly ProcedureStep[],
): Promise<Outcome> => {
  try {
    const run = await runProcedure(sql, steps, subject);
    return { kind: "ran", committed: run.committed, steps: run.steps.map((step) => step.name) };
  } catch (error) {
    if (!(error instanceof ProcedureRefusal)) throw error;

    // A pre-flight refusal carries the one step that ran, so a case can say WHICH steps executed
    // rather than only that a refusal arrived. Every other refusal names no step: the ones that
    // reached a step carry it in the message, and the ones that did not never ran one.
    return {
      kind: "refused",
      message: error.message,
      steps: error instanceof PreflightRefusal ? [error.outcome.name] : [],
    };
  }
};

/** How many active owners an institution has, counted from the table rather than from the guard. */
const activeOwners = async (sql: Sql, institutionId: string): Promise<number> => {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from institution_memberships
     where institution_id = ${institutionId}
       and membership_role = ${ACTIVE_OWNER}
       and status = ${ACTIVE}`;
  return rows[0]?.n ?? 0;
};

const rowExists = async (
  sql: Sql,
  table: "users" | "institutions",
  id: string,
): Promise<boolean> => {
  const rows =
    table === "users"
      ? await sql<{ n: number }[]>`select count(*)::int as n from users where id = ${id}`
      : await sql<{ n: number }[]>`select count(*)::int as n from institutions where id = ${id}`;
  return rows[0]?.n === 1;
};

// ---------------------------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------------------------

describe.skipIf(skipWithoutDatabase)("the pre-flight refusal", () => {
  it("refuses an account that is the last active owner, names every institution it would orphan, and writes nothing", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "sole-company",
        spec: {
          institutionType: "company",
          competitionStatuses: ["draft", "published"],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
      {
        label: "personal",
        spec: {
          institutionType: "personal",
          competitionStatuses: ["archived"],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
      {
        label: "co-owner-inactive",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: "inactive" },
          ],
        },
      },
      {
        // The discriminator: the subject owns this one too, and is NOT its last active owner.
        label: "co-owner-active",
        spec: {
          institutionType: "company",
          competitionStatuses: ["published"],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: ACTIVE },
          ],
        },
      },
    ]);

    try {
      const outcome = await attemptDeletion(sql, fixture.subject, procedureSteps());
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;

      const [headline, ...lines] = outcome.message.split("\n");
      expect(headline).toBe("subject is the last active owner of 3 institution(s)");

      const orphaned = fixture.institutions.filter((institution) => institution.slug !== "");
      const expected = orphaned
        .filter((institution) => !institution.slug.includes("co-owner-active"))
        .map(expectedLine)
        .sort();
      expect([...lines].sort()).toEqual(expected);

      // The other half of the discriminator, asserted rather than implied by the line count.
      const shared = orphaned.find((institution) => institution.slug.includes("co-owner-active"));
      expect(outcome.message).not.toContain(shared!.slug);

      // Nothing was written: the account and both of its memberships are still there.
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
      expect(await activeOwners(sql, shared!.id)).toBe(2);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("refuses with no step of the transaction in the list at all, so the refusal cannot have come from one", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "sole",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
    ]);

    try {
      // The strongest available form of "before the first write": the list handed to the runner is
      // the pre-flight ALONE. No transaction step is even offered, so a refusal that still arrives
      // cannot have come from one — and the run reports the single step that executed.
      const preflightOnly = procedureSteps().filter((step) => step.name === PREFLIGHT_STEP_NAME);
      const { sql: recorded, statements } = recordingClient(sql);
      const outcome = await attemptDeletion(recorded, fixture.subject, preflightOnly);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;

      // THE RECORDER HAS TO HAVE HEARD SOMETHING FOR ITS SILENCE TO MEAN ANYTHING. An empty list
      // satisfies every "does not contain" assertion below, so a recorder that stopped recording and
      // a pre-flight that issued nothing are the same observation until this clause separates them.
      expect(
        statements.length,
        "The recorder captured no statement at all, so every claim below would pass over an empty " +
          "list — a pre-flight that never reached the database and one that refused before a write " +
          "read the same.",
      ).toBeGreaterThan(0);

      // The ORDER is the claim, and it is the half `outcome.steps` cannot carry: a refusal from
      // inside a transaction would have issued `begin` first, and would then have performed a write
      // the pre-flight exists to precede (LAUNCH-D167).
      expect(statements.some((statement) => OPENS_OR_CLOSES_A_TRANSACTION.test(statement))).toBe(
        false,
      );

      expect(outcome.message).toBe(
        `subject is the last active owner of 1 institution(s)\n${expectedLine(fixture.institutions[0]!)}`,
      );
      expect(outcome.steps).toEqual([PREFLIGHT_STEP_NAME]);
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("refuses a run handed no pre-flight step, rather than performing the deletion that step exists to prevent", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "sole-without-preflight",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
    ]);

    try {
      // The account is the one every case above refuses. Drop the step that refuses it and the run
      // must still refuse: `delete` is in this list, and the institution is exactly as orphanable as
      // it was a case ago.
      const withoutPreflight = procedureSteps().filter((step) => step.name !== PREFLIGHT_STEP_NAME);
      const { sql: recorded, statements } = recordingClient(sql);
      const outcome = await attemptDeletion(recorded, fixture.subject, withoutPreflight);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;

      // "RATHER THAN PERFORMING THE DELETION" is the title's other half, and the empty step list
      // does not carry it: `attemptDeletion` reports `[]` for every refusal that is not the
      // pre-flight's, so a `delete` that ran and rolled back would leave the list just as empty.
      // The statements themselves are what can fail here (LAUNCH-D167).
      const issued = new Set(statements);
      expect(withoutPreflight.some((step) => issued.has(step.body))).toBe(false);
      expect(outcome.steps).toEqual([]);

      expect(outcome.message).toContain(PREFLIGHT_STEP_NAME);
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("lets the deletion proceed when a second active owner holds the institution, and leaves that owner standing", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "shared",
        spec: {
          institutionType: "company",
          competitionStatuses: ["published", "archived"],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: ACTIVE },
          ],
        },
      },
    ]);

    try {
      const institution = fixture.institutions[0]!;
      const outcome = await attemptDeletion(sql, fixture.subject, procedureSteps());

      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") return;

      expect(outcome.committed).toBe(true);
      expect(outcome.steps).toContain("delete");

      // The deletion happened, and the institution survives with the owner who did not leave.
      expect(await rowExists(sql, "users", fixture.subject)).toBe(false);
      expect(await rowExists(sql, "users", fixture.coOwner)).toBe(true);
      expect(await rowExists(sql, "institutions", institution.id)).toBe(true);
      expect(await activeOwners(sql, institution.id)).toBe(1);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("refuses a personal institution the subject solely owns, which has no second owner to appoint", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "sole-personal",
        spec: {
          institutionType: "personal",
          competitionStatuses: ["draft", "published", "archived"],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
    ]);

    try {
      const outcome = await attemptDeletion(sql, fixture.subject, procedureSteps());
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;

      expect(outcome.message).toBe(
        `subject is the last active owner of 1 institution(s)\n${expectedLine(fixture.institutions[0]!)}`,
      );
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("refuses when the only co-owner membership is invited, revoked or a staff role rather than an active owner", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "co-owner-invited",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: "invited" },
          ],
        },
      },
      {
        label: "co-owner-revoked",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: "revoked" },
          ],
        },
      },
      {
        label: "co-owner-is-staff",
        spec: {
          institutionType: "company",
          competitionStatuses: [],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: "institution_staff", status: ACTIVE },
          ],
        },
      },
    ]);

    try {
      const outcome = await attemptDeletion(sql, fixture.subject, procedureSteps());
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;

      const [, ...lines] = outcome.message.split("\n");
      expect([...lines].sort()).toEqual(fixture.institutions.map(expectedLine).sort());
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeFixture(sql, fixture);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------

/**
 * One real run of the runner, as an operator would type it.
 *
 * A CHILD PROCESS rather than a call, for the reason `deletion-procedure.test.ts` gives about the
 * runs it spawns: `main` is not exported, and exporting it so it could be called here would prove
 * the function rather than the wiring (Rule 33). What an operator typing the command gets is what
 * is measured.
 *
 * `DATABASE_URL` and `APP_ENV` are set rather than inherited: `process.loadEnvFile` does not
 * override a variable already present in the process, so declaring them is what stops a developer's
 * own `.env.local` from deciding the result of these assertions.
 */
const runCommandLine = (
  userId: string,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/project/run-deletion-procedure.ts", userId],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: DATABASE_URL,
        APP_ENV: "local",
        NEXT_PUBLIC_APP_ENV: "",
      },
    },
  );

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * What a refused command-line run owes, whichever of the two layers refused it.
 *
 * The stack check is a REGEX for an indented frame rather than a prefix test, because a stack is
 * printed BELOW the message: a refusal that carried one would still open with the refusal line.
 */
const expectRefusedRun = (result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): void => {
  expect(result.status).toBe(1);
  expect(result.stderr.startsWith("refusing to delete: ")).toBe(true);
  expect(result.stderr).not.toMatch(/^\s+at /m);

  // A refusal is the answer, not a record: stdout carries the connection's own report of where the
  // command was pointed and nothing else, so a refused run cannot be read as one that finished.
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  expect(result.stdout).toContain("delete target: ");
};

/**
 * A row only the schema can refuse: a note the subject AUTHORED, targeting an institution.
 *
 * `platform_ops_notes.created_by_id` is NOT NULL and NO ACTION, and the note's target is an
 * institution rather than the account, so the cascade that removes the account's own rows does not
 * reach it and step 5 refuses with `23503` (LAUNCH-D105's worked case). Planted rather than borrowed
 * from a seeded database, so what this suite measures does not depend on what the seed left behind.
 */
const plantBlockingNote = async (
  sql: Sql,
  authorId: string,
  institutionId: string,
): Promise<void> => {
  await sql`insert into platform_ops_notes (target_institution_id, note, created_by_id)
    values (${institutionId}, 'planted by the command-line refusal case', ${authorId})`;
};

/** Remove the planted blocker and assert it is gone (Rule 35) — the next teardown depends on it. */
const removeBlockingNote = async (sql: Sql, authorId: string): Promise<void> => {
  await sql`delete from platform_ops_notes where created_by_id = ${authorId}`;

  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from platform_ops_notes where created_by_id = ${authorId}`;

  if (row!.n !== 0) {
    throw new Error(`the teardown left ${row!.n} planted note(s) behind for their author`);
  }
};

describe.skipIf(skipWithoutDatabase)("the command line", () => {
  it("refuses a subject the pre-flight refuses, naming it on stderr and exiting non-zero", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "sole-company",
        spec: {
          institutionType: "company",
          competitionStatuses: ["published"],
          members: [{ user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE }],
        },
      },
    ]);

    try {
      const result = runCommandLine(fixture.subject);

      expectRefusedRun(result);
      expect(result.stderr).toContain("subject is the last active owner of 1 institution(s)");
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeFixture(sql, fixture);
    }
  });

  it("refuses a subject a blocking row refuses, in the same shape and with nothing written", async () => {
    const sql = guardedClient();
    const fixture = await plantFixture(sql, [
      {
        label: "shared-company",
        // A second active owner, so the pre-flight lets this deletion through and the refusal that
        // arrives is the schema's rather than the guard's.
        spec: {
          institutionType: "company",
          competitionStatuses: ["published"],
          members: [
            { user: "subject", membershipRole: ACTIVE_OWNER, status: ACTIVE },
            { user: "co-owner", membershipRole: ACTIVE_OWNER, status: ACTIVE },
          ],
        },
      },
    ]);

    try {
      await plantBlockingNote(sql, fixture.subject, fixture.institutions[0]!.id);

      const result = runCommandLine(fixture.subject);

      expectRefusedRun(result);
      expect(result.stderr).toContain("23503");
      expect(await rowExists(sql, "users", fixture.subject)).toBe(true);
    } finally {
      await removeBlockingNote(sql, fixture.subject);
      await removeFixture(sql, fixture);
    }
  });
});
