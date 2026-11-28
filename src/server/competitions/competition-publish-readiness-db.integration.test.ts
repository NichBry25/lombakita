// @vitest-environment node
//
// READINESS AND THE PUBLISH PATH MUST AGREE, GATE BY GATE — against a real Postgres.
//
// `resolveCompetitionPublishReadiness` exists so the Terbitkan control can say what the SERVER will
// do rather than what the FORM looks like. That promise is only worth anything if the two answers
// are the same answer, so this suite builds a fixture that fails exactly ONE gate, asks readiness
// what it thinks, and then POSTs the real publish endpoint and reads what IT thinks. Both must name
// the same code, once per gate.
//
// The publish call is the production route, not the service function. A route that mapped the code
// to something else — or dropped it — would satisfy a service-level assertion while lying to the
// control, which is exactly the defect this is meant to catch.
//
// The seam is drawn at the two questions the route asks that a rolled-back transaction cannot
// answer: which database (the pooled client, not this transaction) and who is signed in (a cookie
// this process does not have). One test also skips the contact gate's read, to stand in for a
// deletion that clears the contact after it; every other test runs the real gate. Everything
// else — the route handler, `assertCompetitionInInstitution`, `transitionCompetitionStatus`, every
// guard, and all the SQL — is the production code, reading rows this suite inserted through the
// real schema. Both the readiness call and the route are handed the
// SAME transaction, so they are looking at the same uncommitted state.
//
// Every test runs inside a transaction that is always rolled back.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// The route reads the pooled connection and the session cookie; this process has neither. Both are
// staged per call by `publishViaRoute`, and reset before each test.
//
// THEY LIVE IN `vi.hoisted` RATHER THAN IN MODULE-SCOPE `let`s, AND THAT IS NOT STYLE. A `vi.mock`
// factory is hoisted above every import in this file, and the route imported below reaches
// `@/server/auth/session` -> `auth.config.ts`, which calls `getDb()` AT MODULE SCOPE to build its
// Drizzle adapter. So `getDb()` is reached DURING THIS FILE'S OWN INITIALISATION, before any
// module-scope `let` has been assigned. A factory closing over one throws "Cannot access
// 'routeTransaction' before initialization", which vitest reports as "There was an error when
// mocking a module", and the file collects ZERO tests. That is what happened whenever DATABASE_URL
// was exported into the environment, which is how CI runs this suite — so the whole file was dark
// there, reporting one failed suite and no tests. With the variable only in `.env.local` the auth
// adapter is unconfigured, the module-scope read never happens, and the file looked healthy.
// `vi.hoisted` runs before the imports, so the state is assigned either way.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  // False until the first test starts. Before that a `getDb()` call can only be the auth adapter
  // wiring itself up during module initialisation, which is not a test reading the database.
  testRunStarted: false,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      // Module initialisation. `auth.config.ts` only calls `getDb()` when it holds a database URL,
      // so the real client is configured at exactly the point this branch is reachable; nothing is
      // under test yet and there is no staged transaction to hand back.
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("the publish route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) {
      throw new Error("the publish route ran with no session staged");
    }
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
  requireSessionRole: async () => {
    if (!routeState.actorUserId) {
      throw new Error("a route ran with no session staged");
    }
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

// What the account path of the name check tests needs: the sign-up and Email organisasi codes are
// caught here instead of mailed, the code rate limit counts in memory, the Path C upload is
// presigned locally, and nothing is sent or queued once a decision commits.
const accountMocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  organizationCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
}));

const hostKeys = vi.hoisted(() => ({ one: Buffer.alloc(32, 11).toString("base64") }));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: "test-registration-code-secret",
      hostIdentityHashKey: hostKeys.one,
    },
  };
});

vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: async (options: { email: string; code: string }) => {
    accountMocks.sentCodes.push({ email: options.email, code: options.code });
  },
  sendOrganizationEmailCode: async (options: { email: string; code: string }) => {
    accountMocks.organizationCodes.push({ email: options.email, code: options.code });
  },
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    checkFixedWindowLimitFailClosed: async (params: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => {
      const count = (accountMocks.windowCounts.get(params.key) ?? 0) + 1;
      accountMocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueCompetitionSearchSync: vi.fn(async () => ({})),
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: vi.fn(async () => ({})),
    enqueueHostTrustRemoved: vi.fn(async () => ({})),
    enqueueInstitutionTickNotice: vi.fn(async () => ({})),
  };
});

vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return {
    ...actual,
    isR2Available: () => true,
    generatePresignedPutUrl: async (key: string) => `https://r2.test/${key}`,
    listObjects: async () => [],
    deleteObject: async () => undefined,
  };
});

// One test stands in for an account deletion that clears the contact after the publish gate read
// it. While the flag is off, every test runs the real gate.
const contactGateState = vi.hoisted(() => ({ skipGate: false }));

vi.mock("@/server/competitions/competition-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/competitions/competition-access")>();
  return {
    ...actual,
    assertCompetitionHasOrganizerContact: async (
      ...args: Parameters<typeof actual.assertCompetitionHasOrganizerContact>
    ): Promise<void> => {
      if (contactGateState.skipGate) return;
      await actual.assertCompetitionHasOrganizerContact(...args);
    },
  };
});

import { POST as publishCompetition } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { POST as submitVerificationRoute } from "@/app/api/v1/institutions/[institutionSlug]/verification/submit/route";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionFee } from "@/server/competitions/competition-fee-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import { removeHostTrust } from "@/server/host-trust/host-trust-removal-service";
import {
  acceptInstitutionInvitationForUser,
  createInstitutionInvitation,
} from "@/server/institution-invitations/invitation-service";
import {
  createInstitutionWorkspaceForUser,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import { decideNameCheck } from "@/server/institution-verification/name-check-service";
import { tickByOrganizationDomain } from "@/server/institution-verification/tick-service";
import { reviewVerificationSubmission } from "@/server/institution-verification/submission-service";
import { verifyInstitution } from "@/server/institution-verification/verification-service";
import { savePaymentInstructions } from "@/server/institutions/payment-instructions-service";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

// Collection is finished, so every `getDb()` from here belongs to a test.
beforeAll(() => {
  routeState.testRunStarted = true;
});

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
  /** How the tick was won. Planted on the row as the gate cases plant every state. Needs `verified`. */
  tickPath?: "domain";
  suspended?: boolean;
  /** The RECRUITER verification tier of the acting account. Publishing needs `elevated`. */
  actorTier?: "minimal" | "elevated";
  /** The acting account's membership in this institution. Publishing needs `institution_owner` or `institution_staff`. */
  actorRole?: "institution_owner" | "institution_staff" | "institution_member";
  mode?: "individual" | "team" | "both";
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  /** Whether the competition passes the publish checklist. */
  validChecklist?: boolean;
  /** Registration fee in the currency's smallest unit. Non-zero makes it a paid competition. */
  feeAmount?: number | null;
  /** How many OTHER already-published competitions this institution owns. */
  otherPublished?: number;
  /** The competition's status. A published row is one the transition gate refuses to move again. */
  status?: "draft" | "published";
  /** Whether the competition has no contact for participants. Publishing needs one. */
  withoutContact?: boolean;
  /** Whether the competition has no audience (Untuk). Publishing needs one. */
  withoutAudience?: boolean;
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
    withContact: boolean;
    withAudience: boolean;
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
      // Every fixture names a location, so a gate case fails the one gate it is about. The
      // location itself is part of the checklist, which its own suite covers.
      location: "online",
      audience: input.withAudience ? ["umum"] : null,
      minTeamSize: input.minTeamSize,
      maxTeamSize: input.maxTeamSize,
      status: input.status ?? "draft",
      feeAmount: input.feeAmount,
      // `competitions_fee_currency_required_chk`: a competition that charges anything must name the
      // currency its integer counts.
      feeCurrency: input.feeAmount ? "IDR" : null,
      ...timeline,
      ...(input.withContact
        ? { organizerContactKind: "whatsapp" as const, organizerContactValue: "6281234567890" }
        : {}),
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
      displayName: `Readiness Fixture ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: options.verificationStatus ?? "pending_verification",
      tickPath: options.tickPath ?? null,
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
    status: options.status,
    withContact: !options.withoutContact,
    withAudience: !options.withoutAudience,
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
      withContact: false,
      withAudience: false,
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

type PublishResponseBody = {
  error?: { code?: string };
  competition?: { status?: string };
};

// The real publish endpoint, reached the way the shells reach it: a POST carrying the acting user's
// id, with the slug and competition id in the path.
const publishViaRoute = async (
  fixture: Pick<Fixture, "institutionSlug" | "competitionId">,
  actorUserId: string,
  tx: Tx,
): Promise<{ status: number; code: string | null; body: PublishResponseBody }> => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = actorUserId;

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
  const body = (await response.json()) as PublishResponseBody;
  return { status: response.status, code: body.error?.code ?? null, body };
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
    // An institution_member of the owning institution: real membership, no access to competitions.
    seed: (tx) => seedFixture(tx, { actorRole: "institution_member" }),
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
    code: "competition_organizer_contact_missing",
    // A complete draft with no contact for participants.
    seed: (tx) => seedFixture(tx, { withoutContact: true }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_audience_missing",
    // A complete draft with a location and no audience.
    seed: (tx) => seedFixture(tx, { withoutAudience: true }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_institution_not_verified",
    // The charging gate (DEC-0158): paid, under an institution that is not verified.
    seed: (tx) => seedFixture(tx, { feeAmount: 50_000 }),
    expectedHttpStatus: 422,
  },
  {
    code: "competition_institution_name_check_pending",
    // Paid, under a verified institution whose tick came by its email domain and whose name no
    // staff member has checked. Planted like every case of this table. The tests of the name check
    // below build the same refusal through the sign-up, the tick and the fee services.
    seed: (tx) =>
      seedFixture(tx, { feeAmount: 50_000, verificationStatus: "verified", tickPath: "domain" }),
    expectedHttpStatus: 422,
  },
];

describe.skipIf(skipWithoutDatabase)(
  "readiness and the publish endpoint name the same refusal",
  () => {
    beforeEach(() => {
      routeState.transaction = null;
      routeState.actorUserId = null;
      contactGateState.skipGate = false;
    });

    // Readiness never reports the transition code, the endpoint's answer for a published competition, tested below.
    it("covers every blocker code the module declares, except the transition code", () => {
      const exercised = GATE_CASES.map((gate) => gate.code).sort();
      const reportedByReadiness = COMPETITION_PUBLISH_BLOCKER_CODES.filter(
        (code) => code !== "competition_invalid_transition",
      );
      expect(exercised).toEqual([...reportedByReadiness].sort());
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
    routeState.transaction = null;
    routeState.actorUserId = null;
    contactGateState.skipGate = false;
  });

  it("refuses at the write when the contact is gone after the gate passed, and the draft stays a draft", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, { withoutContact: true });
      contactGateState.skipGate = true;

      const published = await publishViaRoute(fixture, fixture.actorUserId, tx);
      expect(published.status).toBe(422);
      expect(published.code).toBe("competition_invalid_transition");

      const [row] = await tx
        .select({ status: competitions.status, publishedAt: competitions.publishedAt })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId))
        .limit(1);
      expect(row?.status).toBe("draft");
      expect(row?.publishedAt).toBeNull();
    });
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

  it("reports canPublish for staff on a paid draft of a verified institution, and the endpoint publishes it", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, {
        actorRole: "institution_staff",
        feeAmount: 50_000,
        verificationStatus: "verified",
      });

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

  it("reports canPublish for a team draft of a personal workspace with two published, and the endpoint publishes it", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, {
        institutionType: "personal",
        mode: "team",
        minTeamSize: 2,
        maxTeamSize: 5,
        otherPublished: 2,
      });

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

  // A published competition has no publish control, so readiness names no reason for it, while the
  // endpoint still refuses the attempt with the transition code. The row is published through the
  // real route rather than seeded with `status: 'published'`, so it carries the `published_at`
  // production writes and both answers are read from one row.
  it("names no reason for an already-published competition, and the endpoint still refuses", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, { feeAmount: null });

      const first = await publishViaRoute(fixture, fixture.actorUserId, tx);
      expect(first.status).toBe(200);

      const readiness = await readinessFor(fixture.actorUserId, fixture.competitionId, tx);
      expect(readiness.blockers).toEqual([]);
      expect(readiness.canPublish).toBe(false);

      const second = await publishViaRoute(fixture, fixture.actorUserId, tx);
      expect(second.code).toBe("competition_invalid_transition");
      expect(second.status).toBe(422);
    });
  });
});

// ── The name check of a paid publish, built through the real services ────────────────────────────
//
// Accounts come through the real sign-up, code verification and host step services, the Email
// organisasi through its real code services, workspaces, invitations and payment instructions
// through their services, drafts and fees through the competition services, requests through the
// real submit route handler with the Rule 16 header, and decisions through the real decision
// services. Every sign-up address is under surel.local and every Email organisasi under
// students.acme.example, both reserved names.
//
// One row is written directly: the date a staff member checked a name, by the test that needs a
// checked name, because the staff decision that writes it is not part of this file.

const PASSWORD = "fresh-pass-3";

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const PAID_FEE_AMOUNT = 50_000;

const COMPANY_DOCUMENTS = ["npwp", "nib"].map((documentType) => ({
  documentType,
  originalFileName: `${documentType}.pdf`,
  fileSizeBytes: 1024,
  contentType: "application/pdf",
}));

const INSTAGRAM_REQUEST = { path: "instagram", instagramUrl: "https://instagram.com/acme.org" };

const asDatabase = (tx: Tx): Database => tx as unknown as Database;

const latestSignUpCode = (): string => {
  const sent = accountMocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const latestOrganizationCodeFor = (address: string): string => {
  const sent = accountMocks.organizationCodes.filter((entry) => entry.email === address).at(-1);
  if (!sent) throw new Error(`No Email organisasi code was sent to ${address}`);
  return sent.code;
};

type NameCheckOwner = { ownerId: string; institutionId: string; slug: string };

// A host with a confirmed Email organisasi, which trusts the account (recruiter tier elevated).
const buildTrustedHost = async (tx: Tx, localPart: string): Promise<string> => {
  const database = asDatabase(tx);
  const signUpAddress = `${localPart}@surel.local`;
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, email: signUpAddress, password: PASSWORD },
    database,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, email: signUpAddress, code: latestSignUpCode(), password: PASSWORD },
    database,
  );
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, signUpAddress));
  if (!user) throw new Error("No user row");
  await markRoleAsVerified(user.id, "recruiter", null, database);

  const organizationAddress = `${localPart}@students.acme.example`;
  await issueOrganizationEmailCode(user.id, organizationAddress, database);
  await confirmOrganizationEmailCode(
    user.id,
    latestOrganizationCodeFor(organizationAddress),
    database,
  );
  return user.id;
};

// A company workspace of a trusted host with its website saved, not ticked yet.
const buildUntickedWorkspace = async (tx: Tx, localPart: string): Promise<NameCheckOwner> => {
  const database = asDatabase(tx);
  const ownerId = await buildTrustedHost(tx, localPart);
  const workspace = await createInstitutionWorkspaceForUser(
    ownerId,
    { displayName: `Ruang Kerja ${randomUUID().slice(0, 8)}`, institutionType: "company" },
    database,
  );
  await updateInstitutionProfileForOwnerBySlug(
    ownerId,
    workspace.slug,
    { websiteUrl: "https://www.acme.example" },
    database,
  );
  return { ownerId, institutionId: workspace.institutionId, slug: workspace.slug };
};

// The workspace of a Path A tick, whose name no staff member has checked.
const buildPathAWorkspace = async (tx: Tx, localPart: string): Promise<NameCheckOwner> => {
  const owner = await buildUntickedWorkspace(tx, localPart);
  await tickByOrganizationDomain(owner.ownerId, owner.slug, asDatabase(tx));
  return owner;
};

const buildTrustedStaff = async (tx: Tx, owner: NameCheckOwner): Promise<string> => {
  const database = asDatabase(tx);
  const staffId = await buildTrustedHost(tx, "p4-staf");
  const [staff] = await tx
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, staffId));
  if (!staff) throw new Error("No staff user row");
  const invitation = await createInstitutionInvitation(
    owner.ownerId,
    owner.slug,
    { invitedIdentifier: staff.username, invitedRole: "institution_staff" },
    database,
  );
  await acceptInstitutionInvitationForUser(
    invitation.id,
    staffId,
    ["candidate", "recruiter"],
    database,
  );
  return staffId;
};

const seedPlatformOps = async (tx: Tx): Promise<string> => {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await tx
    .insert(users)
    .values({
      email: `ops_p4_${suffix}@example.test`,
      username: `ops_p4_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

// What a paid draft needs from its workspace before its fee can be set: where the money goes and a
// fee rule in force.
const preparePaidSelling = async (tx: Tx, owner: NameCheckOwner): Promise<void> => {
  await savePaymentInstructions(
    owner.ownerId,
    owner.institutionId,
    {
      bankName: "Bank Contoh",
      accountNumber: "1234567890",
      accountHolderName: "Panitia Lomba",
      qrisR2Key: null,
      instructionsNote: null,
    },
    asDatabase(tx),
  );
  await tx.insert(schema.financeFeeRules).values({
    institutionId: owner.institutionId,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(Date.now() - DAY),
  });
};

const createPublishableDraft = async (
  tx: Tx,
  owner: NameCheckOwner,
  title: string,
): Promise<string> => {
  const database = asDatabase(tx);
  const draft = await createCompetitionDraft(
    owner.ownerId,
    {
      institutionSlug: owner.slug,
      title,
      description: "Deskripsi kompetisi untuk pengujian.",
      slug: null,
      category: "hackathon",
      mode: "individual",
      ...validTimeline(),
    },
    database,
  );
  await updateCompetitionDraft(owner.ownerId, draft.id, { location: "online" }, database);
  await setCompetitionEligibilityForEditor(
    owner.ownerId,
    draft.id,
    { audience: ["umum"] },
    database,
  );
  await setCompetitionOrganizerContactForEditor(
    owner.ownerId,
    draft.id,
    { kind: "whatsapp", value: "081298765432" },
    database,
  );
  return draft.id;
};

const setPaidFee = (tx: Tx, owner: NameCheckOwner, competitionId: string, feeAmount: number) =>
  setCompetitionFee(
    owner.ownerId,
    competitionId,
    { feeAmount, feeCurrency: "IDR", feeDisclosureAcknowledged: true },
    asDatabase(tx),
    new Date(),
  );

const createPaidDraft = async (tx: Tx, owner: NameCheckOwner, title: string): Promise<string> => {
  const competitionId = await createPublishableDraft(tx, owner, title);
  await setPaidFee(tx, owner, competitionId, PAID_FEE_AMOUNT);
  return competitionId;
};

const submitVerificationRequest = async (
  tx: Tx,
  owner: NameCheckOwner,
  body: Record<string, unknown>,
): Promise<string> => {
  routeState.transaction = asDatabase(tx);
  routeState.actorUserId = owner.ownerId;
  const response = await submitVerificationRoute(
    new Request(`http://localhost/api/v1/institutions/${owner.slug}/verification/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: owner.ownerId },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionSlug: owner.slug }) },
  );
  const answer = (await response.json()) as { submissionId?: string };
  expect(response.status).toBe(201);
  if (!answer.submissionId) throw new Error("The submit route returned no submission id");
  return answer.submissionId;
};

const tickStateOf = async (tx: Tx, institutionId: string) => {
  const [row] = await tx
    .select({
      verificationStatus: institutions.verificationStatus,
      tickPath: institutions.tickPath,
      nameCheckedAt: institutions.nameCheckedAt,
    })
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  if (!row) throw new Error("No institution row");
  return row;
};

const tierOf = async (tx: Tx, userId: string) => {
  const [row] = await tx
    .select({ tier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

const storedStatusOf = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({ status: competitions.status })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.status;
};

const hostCheckRowsOf = (tx: Tx, userId: string) =>
  tx
    .select({
      competitionId: schema.recruiterVerificationSubmissions.competitionId,
      status: schema.recruiterVerificationSubmissions.status,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.userId, userId));

describe.skipIf(skipWithoutDatabase)("the name check of a paid publish", () => {
  beforeEach(() => {
    routeState.transaction = null;
    routeState.actorUserId = null;
    contactGateState.skipGate = false;
    accountMocks.sentCodes.length = 0;
    accountMocks.organizationCodes.length = 0;
    accountMocks.windowCounts.clear();
  });

  it("a paid draft of a Path A workspace whose name is unchecked does not publish", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = asDatabase(tx);
      const owner = await buildPathAWorkspace(tx, "p4-pemilik");
      const staffId = await buildTrustedStaff(tx, owner);
      await preparePaidSelling(tx, owner);
      const paidDraftId = await createPaidDraft(tx, owner, "Lomba Berbayar");
      expect(await tickStateOf(tx, owner.institutionId)).toMatchObject({
        tickPath: "domain",
        nameCheckedAt: null,
      });
      expect(await tierOf(tx, staffId)).toBe("elevated");

      const press = async (presserId: string) => {
        const answer = await publishViaRoute(
          { institutionSlug: owner.slug, competitionId: paidDraftId },
          presserId,
          tx,
        );
        return {
          status: answer.status,
          code: answer.code,
          stored: await storedStatusOf(tx, paidDraftId),
          hostChecks: await hostCheckRowsOf(tx, presserId),
        };
      };
      const refusal = {
        status: 422,
        code: "competition_institution_name_check_pending",
        stored: "draft",
        hostChecks: [],
      };

      expect(await press(owner.ownerId)).toEqual(refusal);
      expect(await press(staffId)).toEqual(refusal);

      const operatorId = await seedPlatformOps(tx);
      await removeHostTrust(operatorId, owner.ownerId, "Kepercayaan dicabut", asDatabase(tx));
      expect(await tierOf(tx, owner.ownerId)).toBe("minimal");

      expect(await press(owner.ownerId)).toEqual(refusal);
    });
  });

  it("a free draft of the same workspace publishes", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = asDatabase(tx);
      const owner = await buildPathAWorkspace(tx, "p4-pemilik");
      const freeDraftId = await createPublishableDraft(tx, owner, "Lomba Gratis");

      const answer = await publishViaRoute(
        { institutionSlug: owner.slug, competitionId: freeDraftId },
        owner.ownerId,
        tx,
      );

      expect(answer.status).toBe(200);
      expect(answer.body.competition?.status).toBe("published");
      expect(await storedStatusOf(tx, freeDraftId)).toBe("published");
    });
  });

  it("a paid draft publishes after the name is checked, and on a documents, instagram or staff tick", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = asDatabase(tx);
      const operatorId = await seedPlatformOps(tx);

      const pressPaidDraftOf = async (owner: NameCheckOwner) => {
        await preparePaidSelling(tx, owner);
        const paidDraftId = await createPaidDraft(tx, owner, "Lomba Berbayar");
        const answer = await publishViaRoute(
          { institutionSlug: owner.slug, competitionId: paidDraftId },
          owner.ownerId,
          tx,
        );
        return { status: answer.status, stored: await storedStatusOf(tx, paidDraftId) };
      };
      const published = { status: 200, stored: "published" };

      // Case 1. A platform_ops account finds the name fine.
      const checkedOwner = await buildPathAWorkspace(tx, "p4-pemilik");
      await decideNameCheck(
        operatorId,
        checkedOwner.institutionId,
        { decision: "name_ok" },
        asDatabase(tx),
      );
      expect(await tickStateOf(tx, checkedOwner.institutionId)).toMatchObject({
        tickPath: "domain",
      });
      expect(await pressPaidDraftOf(checkedOwner)).toEqual(published);

      // Case 2. A documents tick, through a Path C request and its approval.
      const documentsOwner = await buildUntickedWorkspace(tx, "p4-dokumen");
      const documentsRequestId = await submitVerificationRequest(tx, documentsOwner, {
        documents: COMPANY_DOCUMENTS,
      });
      await reviewVerificationSubmission(
        documentsRequestId,
        "approved",
        null,
        operatorId,
        asDatabase(tx),
      );
      expect(await tickStateOf(tx, documentsOwner.institutionId)).toMatchObject({
        tickPath: "documents",
        nameCheckedAt: null,
      });
      expect(await pressPaidDraftOf(documentsOwner)).toEqual(published);

      // Case 3. An instagram tick, through a Path B request and its approval.
      const instagramOwner = await buildUntickedWorkspace(tx, "p4-instagram");
      const instagramRequestId = await submitVerificationRequest(
        tx,
        instagramOwner,
        INSTAGRAM_REQUEST,
      );
      await reviewVerificationSubmission(
        instagramRequestId,
        "approved",
        null,
        operatorId,
        asDatabase(tx),
      );
      expect(await tickStateOf(tx, instagramOwner.institutionId)).toMatchObject({
        tickPath: "instagram",
        nameCheckedAt: null,
      });
      expect(await pressPaidDraftOf(instagramOwner)).toEqual(published);

      // Case 4. A staff tick, through the staff override.
      const staffOwner = await buildUntickedWorkspace(tx, "p4-keputusan");
      await verifyInstitution({
        institutionId: staffOwner.institutionId,
        targetStatus: "verified",
        actorUserId: operatorId,
        db: asDatabase(tx),
      });
      expect(await tickStateOf(tx, staffOwner.institutionId)).toMatchObject({
        tickPath: "staff",
        nameCheckedAt: null,
      });
      expect(await pressPaidDraftOf(staffOwner)).toEqual(published);
    });
  });

  it("readiness lists the name check for a paid draft only", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = asDatabase(tx);
      const owner = await buildPathAWorkspace(tx, "p4-pemilik");
      await preparePaidSelling(tx, owner);
      const paidDraftId = await createPaidDraft(tx, owner, "Lomba Berbayar");
      const freeDraftId = await createPublishableDraft(tx, owner, "Lomba Gratis");

      const paidReadiness = await readinessFor(owner.ownerId, paidDraftId, tx);
      const freeReadiness = await readinessFor(owner.ownerId, freeDraftId, tx);

      expect(paidReadiness.blockers).toContain("competition_institution_name_check_pending");
      expect(paidReadiness.canPublish).toBe(false);
      expect(freeReadiness.blockers).not.toContain("competition_institution_name_check_pending");
    });
  });

  it("setting a fee on a Path A workspace with an unchecked name is allowed", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = asDatabase(tx);
      const owner = await buildPathAWorkspace(tx, "p4-pemilik");
      await preparePaidSelling(tx, owner);
      const draftId = await createPublishableDraft(tx, owner, "Lomba Tanpa Biaya");
      expect(await tickStateOf(tx, owner.institutionId)).toMatchObject({
        tickPath: "domain",
        nameCheckedAt: null,
      });

      await expect(setPaidFee(tx, owner, draftId, 75_000)).resolves.toBeUndefined();

      // setCompetitionFee returns nothing, so the row is read.
      const [row] = await tx
        .select({ feeAmount: competitions.feeAmount, feeCurrency: competitions.feeCurrency })
        .from(competitions)
        .where(eq(competitions.id, draftId));
      expect(row).toEqual({ feeAmount: 75_000, feeCurrency: "IDR" });
    });
  });
});
