// @vitest-environment node
//
// READINESS AND THE PUBLISH PATH MUST AGREE, GATE BY GATE — against a real Postgres.
//
// `resolveCompetitionPublishReadiness` exists so the Terbitkan control can say what the SERVER will
// do rather than what the FORM looks like. That promise is only worth anything if the two answers
// are the same answer, so this suite builds a fixture that fails exactly ONE gate, asks readiness
// what it thinks, and then POSTs the real publish endpoint and reads what IT thinks. Both must name
// the same code, seven times over, once per gate.
//
// The publish call is the production route, not the service function. A route that mapped the code
// to something else — or dropped it — would satisfy a service-level assertion while lying to the
// control, which is exactly the defect this is meant to catch.
//
// The seam is drawn at the two questions the route asks that a rolled-back transaction cannot
// answer: which database (the pooled client, not this transaction) and who is signed in (a cookie
// this process does not have). Everything else — the route handler, `assertCompetitionInInstitution`,
// `transitionCompetitionStatus`, every guard, and all the SQL — is the production code, reading rows
// this suite inserted through the real schema. Both the readiness call and the route are handed the
// SAME transaction, so they are looking at the same uncommitted state.
//
// Every test runs inside a transaction that is always rolled back.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import { competitions, institutionMemberships, institutions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";
import {
  COMPETITION_PUBLISH_BLOCKER_CODES,
  resolveCompetitionPublishReadiness,
  type CompetitionPublishBlockerCode,
} from "@/server/competitions/competition-publish-readiness";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

// The route reads the pooled connection; these fixtures live in a transaction that is rolled back.
let routeTransaction: Database | null = null;
// The route reads the session cookie; this process has none.
let routeActorUserId: string | null = null;

vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  getDb: () => {
    if (!routeTransaction) throw new Error("the publish route read the database outside a test");
    return routeTransaction;
  },
}));

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeActorUserId) throw new Error("the publish route ran with no session staged");
    return { user: { id: routeActorUserId, role: "recruiter" } } as unknown as AuthenticatedSession;
  },
}));

import { POST as publishCompetition } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const DAY = 24 * 60 * 60 * 1000;

// A checklist-valid timeline: registrationStart < registrationEnd <= participantConfirmation <
// eventStart < eventEnd <= resultAnnouncement, with registrationEnd still in the future. Kept well
// clear of `Date.now()` so a slow run cannot walk a fixture across the future-dated boundary.
const validTimeline = () => {
  const now = Date.now();
  return {
    registrationStartAt: new Date(now + 7 * DAY),
    registrationEndAt: new Date(now + 14 * DAY),
    participantConfirmationAt: new Date(now + 20 * DAY),
    eventStartAt: new Date(now + 30 * DAY),
    eventEndAt: new Date(now + 31 * DAY),
    resultAnnouncementAt: new Date(now + 40 * DAY),
  };
};

type SeedOptions = {
  institutionType?: "company" | "personal";
  verificationStatus?: "pending_verification" | "verified";
  suspended?: boolean;
  /** The RECRUITER verification tier of the acting account. Publishing needs `elevated`. */
  actorTier?: "minimal" | "elevated";
  /** The acting account's membership in this institution. Publishing needs `institution_owner`. */
  actorRole?: "institution_owner" | "institution_staff";
  mode?: "individual" | "team" | "both";
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  /** Whether the competition passes the publish checklist. */
  validChecklist?: boolean;
  /** Registration fee in the currency's smallest unit. Non-zero makes it a paid competition. */
  feeAmount?: number | null;
  /** How many OTHER already-published competitions this institution owns. */
  otherPublished?: number;
};

type Fixture = {
  institutionId: string;
  institutionSlug: string;
  competitionId: string;
  actorUserId: string;
};

const seedUser = async (tx: Tx, tier: "minimal" | "elevated"): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `readiness_${id}@example.test`,
      username: `readiness_${id}`,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: tier,
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedCompetition = async (
  tx: Tx,
  input: {
    institutionId: string;
    validChecklist: boolean;
    mode: "individual" | "team" | "both";
    minTeamSize: number | null;
    maxTeamSize: number | null;
    feeAmount: number | null;
    status?: "draft" | "published";
  },
): Promise<string> => {
  const id = uniqueSuffix();
  const timeline = input.validChecklist ? validTimeline() : {};
  const [row] = await tx
    .insert(competitions)
    .values({
      institutionId: input.institutionId,
      slug: `readiness-comp-${id}`,
      title: `Readiness Fixture ${id}`,
      // The column is NOT NULL DEFAULT '', so a draft that names no description holds an empty
      // string rather than a null — and `findMissingPublishFields` reads `''` as missing, which is
      // the state a half-filled draft is actually in.
      description: input.validChecklist ? "Deskripsi kompetisi untuk pengujian." : "",
      category: input.validChecklist ? "hackathon" : null,
      mode: input.mode,
      minTeamSize: input.minTeamSize,
      maxTeamSize: input.maxTeamSize,
      status: input.status ?? "draft",
      feeAmount: input.feeAmount,
      // `competitions_fee_currency_required_chk`: a competition that charges anything must name the
      // currency its integer counts.
      feeCurrency: input.feeAmount ? "IDR" : null,
      ...timeline,
    })
    .returning({ id: competitions.id });
  return row!.id;
};

const seedFixture = async (tx: Tx, options: SeedOptions = {}): Promise<Fixture> => {
  const id = uniqueSuffix();
  const institutionType = options.institutionType ?? "company";
  const actorRole = options.actorRole ?? "institution_owner";
  const mode = options.mode ?? "individual";
  const validChecklist = options.validChecklist ?? true;

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `readiness-inst-${id}`,
      institutionType,
      // `institutions_display_name_type_chk` allows a null display name only for `personal`.
      displayName: institutionType === "personal" ? null : `Readiness Fixture ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: options.verificationStatus ?? "pending_verification",
      suspendedAt: options.suspended ? new Date() : null,
      suspensionReason: options.suspended ? "integration fixture" : null,
    })
    .returning({ id: institutions.id, slug: institutions.slug });

  const actorUserId = await seedUser(tx, options.actorTier ?? "elevated");
  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: actorUserId,
    membershipRole: actorRole,
    status: "active",
  });

  const competitionId = await seedCompetition(tx, {
    institutionId: institution!.id,
    validChecklist,
    mode,
    // A `team` checklist is invalid below TEAM_MODE_MIN_SIZE, so a fixture that means to fail a
    // DIFFERENT gate has to satisfy the team-size rule too, or it fails two gates and proves
    // nothing about either.
    minTeamSize: options.minTeamSize ?? (mode === "team" ? 2 : null),
    maxTeamSize: options.maxTeamSize ?? (mode === "team" ? 5 : null),
    feeAmount: options.feeAmount ?? null,
  });

  for (let i = 0; i < (options.otherPublished ?? 0); i += 1) {
    await seedCompetition(tx, {
      institutionId: institution!.id,
      validChecklist: false,
      mode: "individual",
      minTeamSize: null,
      maxTeamSize: null,
      feeAmount: null,
      status: "published",
    });
  }

  return {
    institutionId: institution!.id,
    institutionSlug: institution!.slug,
    competitionId,
    actorUserId,
  };
};

const readinessFor = (actorUserId: string, competitionId: string, tx: Tx) =>
  resolveCompetitionPublishReadiness(actorUserId, competitionId, tx as unknown as Database);

// The real publish endpoint, reached the way the shells reach it: a POST carrying the acting user's
// id, with the slug and competition id in the path.
const publishViaRoute = async (
  fixture: Fixture,
  actorUserId: string,
  tx: Tx,
): Promise<{ status: number; code: string | null }> => {
  routeTransaction = tx as unknown as Database;
  routeActorUserId = actorUserId;

  const request = new Request(
    `https://lombakita.test/api/v1/institutions/${fixture.institutionSlug}/competitions/${fixture.competitionId}/publish`,
    { method: "POST", headers: { "X-Expected-User-Id": actorUserId } },
  );
  const response = await publishCompetition(request, {
    params: Promise.resolve({
      institutionSlug: fixture.institutionSlug,
      competitionId: fixture.competitionId,
    }),
  });
  const body = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: body.error?.code ?? null };
};

type GateCase = {
  code: CompetitionPublishBlockerCode;
  /** What makes this fixture fail this gate and no other. */
  seed: (tx: Tx) => Promise<Fixture>;
  expectedHttpStatus: number;
};

const GATE_CASES: GateCase[] = [
  {
    code: "forbidden",
    // A staff member of the owning institution: real membership, wrong role for publishing.
    seed: (tx) => seedFixture(tx, { actorRole: "institution_staff" }),
    expectedHttpStatus: 403,
  },
  {
    code: "competition_recruiter_not_trusted",
    seed: (tx) => seedFixture(tx, { actorTier: "minimal" }),
    expectedHttpStatus: 403,
  },
  {
    code: "institution_suspended",
    seed: (tx) => seedFixture(tx, { suspended: true }),
    expectedHttpStatus: 403,
  },
  {
    code: "competition_publish_validation_failed",
    seed: (tx) => seedFixture(tx, { validChecklist: false }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_institution_not_verified",
    // The charging gate (DEC-0158): paid, under an institution that is not verified.
    seed: (tx) => seedFixture(tx, { feeAmount: 50_000 }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_personal_individual_only",
    seed: (tx) =>
      seedFixture(tx, {
        institutionType: "personal",
        mode: "team",
        minTeamSize: 2,
        maxTeamSize: 5,
      }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_personal_publish_limit",
    seed: (tx) =>
      seedFixture(tx, { institutionType: "personal", mode: "individual", otherPublished: 2 }),
    expectedHttpStatus: 422,
  },
];

describe.skipIf(skipWithoutDatabase)(
  "readiness and the publish endpoint name the same refusal",
  () => {
    beforeEach(() => {
      routeTransaction = null;
      routeActorUserId = null;
    });

    it("covers every blocker code the module declares", () => {
      const exercised = GATE_CASES.map((gate) => gate.code).sort();
      expect(exercised).toEqual([...COMPETITION_PUBLISH_BLOCKER_CODES].sort());
    });

    for (const gate of GATE_CASES) {
      it(`${gate.code} — the only failing gate, reported by both`, async () => {
        await inRollback(async (tx) => {
          const fixture = await gate.seed(tx);

          const readiness = await readinessFor(fixture.actorUserId, fixture.competitionId, tx);
          expect(
            readiness.blockers,
            "a fixture failing exactly one gate must report exactly that gate",
          ).toEqual([gate.code]);
          expect(readiness.canPublish).toBe(false);

          const published = await publishViaRoute(fixture, fixture.actorUserId, tx);
          expect(
            published.code,
            `the publish endpoint refused with a different code than readiness reported`,
          ).toBe(gate.code);
          expect(published.status).toBe(gate.expectedHttpStatus);
        });
      });
    }
  },
);

describe.skipIf(skipWithoutDatabase)("a competition that can publish", () => {
  beforeEach(() => {
    routeTransaction = null;
    routeActorUserId = null;
  });

  it("reports canPublish and then actually publishes", async () => {
    await inRollback(async (tx) => {
      // Free, non-personal, trusted recruiter, owner, valid checklist, not suspended. The
      // institution is deliberately NOT verified: DEC-0158 makes verification a gate on charging,
      // so an unverified organizer publishing a free competition must not be blocked anywhere —
      // least of all by the control that is supposed to predict the server.
      const fixture = await seedFixture(tx, { feeAmount: null });

      const readiness = await readinessFor(fixture.actorUserId, fixture.competitionId, tx);
      expect(readiness.blockers).toEqual([]);
      expect(readiness.canPublish).toBe(true);

      const published = await publishViaRoute(fixture, fixture.actorUserId, tx);
      expect(published.status).toBe(200);
      expect(published.code).toBeNull();

      const [row] = await tx
        .select({ status: competitions.status })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId))
        .limit(1);
      expect(row?.status).toBe("published");
    });
  });
});
