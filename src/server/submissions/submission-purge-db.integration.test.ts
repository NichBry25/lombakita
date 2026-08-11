// @vitest-environment node
//
// The retention predicate, run against a real Postgres.
//
// submission-purge-predicate.test.ts asserts the compiled SQL says the right thing. This asserts
// Postgres AGREES — that a finalized entry is genuinely excluded, that a competition with no
// `event_end_at` is genuinely skipped rather than swept in by NULL-comparison semantics, and that
// the cutoff comparison lands on the right side of the boundary. Those are claims about the
// database's behaviour, and only the database can settle them.
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the dev database is left
// byte-identical. Nothing here is committed.
//
// Skipped when no DATABASE_URL is reachable, so a developer without a local database can still
// run `npm test`. NOT skippable in CI: `REQUIRE_DB_TESTS=1` makes a missing database a hard
// failure instead (see server/testing/database-url.ts) — this suite proving nothing while
// reporting green is the defect this guard exists to prevent.

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError } from "drizzle-orm";
import postgres from "postgres";
import {
  competitionRegistrations,
  competitions,
  competitionSubmissions,
  institutions,
  users,
} from "@/server/db/schema";
import { listCompetitionsDueForSubmissionPurge } from "@/server/submissions/submission-service";

const DATABASE_URL = TEST_DATABASE_URL;

const NOW = new Date("2026-07-30T00:00:00.000Z");
const GRACE_DAYS = 90;
// The cutoff for the above: 2026-05-01.
const LONG_PAST = new Date("2026-01-01T00:00:00.000Z");
const JUST_INSIDE_GRACE = new Date("2026-06-01T00:00:00.000Z");

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

/**
 * Runs `body` inside a transaction and rolls it back unconditionally.
 *
 * An assertion failure inside the body propagates (so the test fails) AND still rolls back,
 * because the rollback is the transaction's own unwind rather than something the body has to
 * remember to do.
 */
const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type SeedOptions = {
  eventEndAt: Date | null;
  finalized: boolean;
};

/** Seeds the full FK chain a submission needs, and returns the competition id. */
const seedSubmission = async (tx: Tx, options: SeedOptions): Promise<string> => {
  const id = uniqueSuffix();

  const [user] = await tx
    .insert(users)
    .values({
      email: `purge_${id}@example.test`,
      username: `purge_${id}`,
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `purge-inst-${id}`,
      // institutions_display_name_type_chk allows a null display name only for `personal`.
      institutionType: "personal",
    })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `purge-comp-${id}`,
      title: `Purge fixture ${id}`,
      eventEndAt: options.eventEndAt,
    })
    .returning({ id: competitions.id });

  const [registration] = await tx
    .insert(competitionRegistrations)
    .values({
      competitionId: competition!.id,
      studentId: user!.id,
      // competition_registrations_type_team_id_chk: individual requires a null team_id.
      registrationType: "individual",
    })
    .returning({ id: competitionRegistrations.id });

  await tx.insert(competitionSubmissions).values({
    registrationId: registration!.id,
    submittedById: user!.id,
    fileKey: `submissions/${competition!.id}/${registration!.id}/${id}`,
    fileName: "entry.pdf",
    finalizedAt: options.finalized ? NOW : null,
  });

  return competition!.id;
};

const due = (tx: Tx): Promise<string[]> =>
  listCompetitionsDueForSubmissionPurge(GRACE_DAYS, tx as never, NOW);

describe.skipIf(skipWithoutDatabase)("listCompetitionsDueForSubmissionPurge (real database)", () => {
  it("returns a competition whose event ended before the cutoff with an unfinalized submission", async () => {
    await inRollback(async (tx) => {
      const competitionId = await seedSubmission(tx, {
        eventEndAt: LONG_PAST,
        finalized: false,
      });
      expect(await due(tx)).toContain(competitionId);
    });
  });

  // The guarantee the whole feature rests on: a finalized entry is the participant's work and is
  // never in scope, however old the competition is.
  it("never returns a competition whose only submission is finalized", async () => {
    await inRollback(async (tx) => {
      const competitionId = await seedSubmission(tx, { eventEndAt: LONG_PAST, finalized: true });
      expect(await due(tx)).not.toContain(competitionId);
    });
  });

  // Proves the IS NOT NULL clause does real work rather than being incidentally satisfied: with a
  // NULL event_end_at, `event_end_at < cutoff` is NULL (not false), and this is what keeps that
  // row out.
  it("never returns a competition with no event end date", async () => {
    await inRollback(async (tx) => {
      const competitionId = await seedSubmission(tx, { eventEndAt: null, finalized: false });
      expect(await due(tx)).not.toContain(competitionId);
    });
  });

  it("does not return a competition still inside its grace window", async () => {
    await inRollback(async (tx) => {
      const competitionId = await seedSubmission(tx, {
        eventEndAt: JUST_INSIDE_GRACE,
        finalized: false,
      });
      expect(await due(tx)).not.toContain(competitionId);
    });
  });

  it("separates a due competition from a not-yet-due one in the same run", async () => {
    await inRollback(async (tx) => {
      const dueId = await seedSubmission(tx, { eventEndAt: LONG_PAST, finalized: false });
      const notDueId = await seedSubmission(tx, {
        eventEndAt: JUST_INSIDE_GRACE,
        finalized: false,
      });

      const result = await due(tx);

      expect(result).toContain(dueId);
      expect(result).not.toContain(notDueId);
    });
  });

  it("leaves the database untouched — the rollback is real", async () => {
    let seededCompetitionId = "";
    await inRollback(async (tx) => {
      seededCompetitionId = await seedSubmission(tx, {
        eventEndAt: LONG_PAST,
        finalized: false,
      });
      expect(await due(tx)).toContain(seededCompetitionId);
    });

    // Outside the transaction the fixture must not exist.
    const survivors = await listCompetitionsDueForSubmissionPurge(GRACE_DAYS, db as never, NOW);
    expect(survivors).not.toContain(seededCompetitionId);
  });
});
