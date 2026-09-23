// @vitest-environment node
//
// THE ONE REFUSAL THAT IS AN ABSENCE, measured against a live Postgres.
//
// WHY THIS SUITE IS DB-BACKED. The pre-flight in `run-deletion-procedure.ts` asks a question no
// reading of the schema module can answer: given THESE membership rows, is the subject the last
// active owner of an institution? Every part of that — which rows exist, which role and status they
// carry, how many owners remain after the subject's own rows go — is a property of the data, and
// the guard is a query. A hand-built object could not be its input, and until this file existed the
// guard's query had never been executed against a database at all: the first run of this suite found
// it selecting a column (`role`) that does not exist on `institution_memberships` (`membership_role`
// is the column), which every unit test in the repository had passed over because none of them
// reached the database. That is Rule 33's case, made concrete: the tests that existed proved the
// function's shape, not its wiring.
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
//     driven with an EMPTY step list: no statement can have run, so a refusal that still arrives
//     cannot have come from one.
//
// NOTHING HERE TOUCHES A NON-LOCAL HOST, and nothing here reports a personal datum: the fixtures are
// generated rows, the assertions compare ids, slugs and counts, and no email, username or other
// column value is ever put into a message. The connection is refused unless its host is loopback,
// before a byte is sent. (Rule 35) every fixture is torn down in a `finally`, and the teardown
// asserts that what it removed is gone rather than that it ran.

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
  PROCEDURE_PATH,
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

/** What a case observed. */
type Outcome =
  | { kind: "refused"; message: string }
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
    return { kind: "refused", message: error.message };
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

  it("refuses before the first write, which an empty step list makes unfalsifiable-adjacent: no statement can have run", async () => {
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
      const outcome = await attemptDeletion(sql, fixture.subject, []);
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
