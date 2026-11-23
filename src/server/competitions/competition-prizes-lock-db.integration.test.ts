// @vitest-environment node
//
// THE PRIZE LOCK, THROUGH THE REAL ROUTES, AGAINST A REAL POSTGRES.
//
// Each test reaches the production prizes route handler (PUT or GET) with a Request, so the access
// check, the guarded write, the registration check and the delete and insert are the code that runs
// in production. A published competition is reached through the publish route and its prizes are
// first saved through the PUT route while it is a draft. Every test runs inside a transaction that
// is always rolled back, so nothing it seeds survives it.
//
// Guards this suite pins, each one failing when the guard is removed or moved below the commit:
//   - the status-conditioned write on the competitions row (competition-prizes-service.ts)
//   - the refusal of a draft that still holds a non-cancelled registration
//
// The registration of the draft case is inserted directly, because no production path leaves a draft
// holding one: unpublish and the operator's cancellation both cancel every registration.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import {
  competitionPrizes,
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  users,
  type CompetitionRegistrationStatus,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

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

// Hoisted because the auth adapter calls `getDb()` while this file's own imports are still being
// evaluated, before any module-scope `let` is assigned.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

const enqueueSpies = vi.hoisted(() => ({
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("a route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) throw new Error("a route ran with no session staged");
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

import {
  GET as getPrizes,
  PUT as putPrizes,
} from "@/app/api/v1/competitions/[competitionId]/prizes/route";
import { POST as publishCompetition } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
  routeState.actorUserId = null;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

const LOCK_SENTENCE = "Hadiah tidak dapat diubah setelah kompetisi terbit.";
const REGISTRATIONS_SENTENCE =
  "Hadiah tidak dapat diubah karena kompetisi ini masih memiliki pendaftar aktif. Hubungi tim Lombakita.";
const LOCKED_CODE = "competition_prizes_locked_after_publish";
const HELD_CODE = "competition_prizes_held_by_registrations";

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

type PrizePayload = {
  rankLabel: string | null;
  title: string;
  cashAmount: number | null;
  isCertificate: boolean;
  description: string | null;
};

const FIRST_PRIZE: PrizePayload = {
  rankLabel: "Juara 1",
  title: "Juara satu",
  cashAmount: 5_000_000,
  isCertificate: true,
  description: "Piala dan sertifikat.",
};

const SECOND_PRIZE: PrizePayload = {
  rankLabel: "Juara 2",
  title: "Juara dua",
  cashAmount: 2_000_000,
  isCertificate: false,
  description: null,
};

const INITIAL_PRIZES: PrizePayload[] = [FIRST_PRIZE, SECOND_PRIZE];

type Seed = {
  ownerId: string;
  institutionSlug: string;
  competitionId: string;
};

const seedOwner = async (tx: Tx): Promise<{ id: string; institutionId: string; slug: string }> => {
  const id = uniqueSuffix();
  const [owner] = await tx
    .insert(users)
    .values({
      email: `prizelock_owner_${id}@example.test`,
      username: `prizelock_owner_${id}`,
      emailVerified: new Date(),
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `prizelock-inst-${id}`,
      institutionType: "company",
      displayName: `Hadiah terkunci ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id, slug: institutions.slug });
  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: owner!.id,
    membershipRole: "institution_owner",
    status: "active",
  });
  return { id: owner!.id, institutionId: institution!.id, slug: institution!.slug };
};

const seedDraftCompetition = async (tx: Tx): Promise<Seed> => {
  const owner = await seedOwner(tx);
  const now = Date.now();
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: owner.institutionId,
      slug: `prizelock-comp-${uniqueSuffix()}`,
      title: "Kompetisi hadiah terkunci",
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      minTeamSize: 1,
      maxTeamSize: 1,
      location: "online",
      audience: ["mahasiswa"],
      status: "draft",
      registrationStartAt: new Date(now - 7 * DAY_MS),
      registrationEndAt: new Date(now + 14 * DAY_MS),
      participantConfirmationAt: new Date(now + 20 * DAY_MS),
      eventStartAt: new Date(now + 30 * DAY_MS),
      eventEndAt: new Date(now + 31 * DAY_MS),
      resultAnnouncementAt: new Date(now + 40 * DAY_MS),
      organizerContactKind: "whatsapp",
      organizerContactValue: "6281234567890",
    })
    .returning({ id: competitions.id });
  return { ownerId: owner.id, institutionSlug: owner.slug, competitionId: competition!.id };
};

const seedRegistration = async (
  tx: Tx,
  competitionId: string,
  status: CompetitionRegistrationStatus,
): Promise<void> => {
  const id = uniqueSuffix();
  const [candidate] = await tx
    .insert(users)
    .values({
      email: `prizelock_candidate_${id}@example.test`,
      username: `prizelock_candidate_${id}`,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  await tx.insert(competitionRegistrations).values({
    competitionId,
    studentId: candidate!.id,
    registrationType: "individual",
    status,
    ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
  });
};

const readPrizeRows = (tx: Tx, competitionId: string) =>
  tx
    .select()
    .from(competitionPrizes)
    .where(eq(competitionPrizes.competitionId, competitionId))
    .orderBy(asc(competitionPrizes.sortOrder));

type RouteAnswer = { status: number; body: Record<string, unknown> };

const answerOf = async (response: Response): Promise<RouteAnswer> => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

const errorOf = (answer: RouteAnswer): { code?: string; message?: string } =>
  (answer.body.error as { code?: string; message?: string } | undefined) ?? {};

const stageActor = (tx: Tx, actorUserId: string): void => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = actorUserId;
};

const putPrizesVia = async (tx: Tx, seed: Seed, prizes: PrizePayload[]): Promise<RouteAnswer> => {
  stageActor(tx, seed.ownerId);
  const request = new Request(
    `https://lombakita.test/api/v1/competitions/${seed.competitionId}/prizes`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Expected-User-Id": seed.ownerId },
      body: JSON.stringify({ prizes }),
    },
  );
  const response = await putPrizes(request, {
    params: Promise.resolve({ competitionId: seed.competitionId }),
  });
  return answerOf(response);
};

const getPrizesVia = async (tx: Tx, seed: Seed): Promise<RouteAnswer> => {
  stageActor(tx, seed.ownerId);
  const request = new Request(
    `https://lombakita.test/api/v1/competitions/${seed.competitionId}/prizes`,
    { method: "GET" },
  );
  const response = await getPrizes(request, {
    params: Promise.resolve({ competitionId: seed.competitionId }),
  });
  return answerOf(response);
};

const publishVia = async (tx: Tx, seed: Seed): Promise<RouteAnswer> => {
  stageActor(tx, seed.ownerId);
  const request = new Request(
    `https://lombakita.test/api/v1/institutions/${seed.institutionSlug}/competitions/${seed.competitionId}/publish`,
    { method: "POST", headers: { "X-Expected-User-Id": seed.ownerId } },
  );
  const response = await publishCompetition(request, {
    params: Promise.resolve({
      institutionSlug: seed.institutionSlug,
      competitionId: seed.competitionId,
    }),
  });
  return answerOf(response);
};

const seedDraftWithSavedPrizes = async (tx: Tx): Promise<Seed> => {
  const seed = await seedDraftCompetition(tx);
  const saved = await putPrizesVia(tx, seed, INITIAL_PRIZES);
  expect(saved.status).toBe(200);
  return seed;
};

const seedPublishedWithSavedPrizes = async (tx: Tx): Promise<Seed> => {
  const seed = await seedDraftWithSavedPrizes(tx);
  const published = await publishVia(tx, seed);
  expect(published.status).toBe(200);
  return seed;
};

// A database whose first UPDATE inside the service's own transaction runs `writeBeforeUpdate`
// first, as a publish from another request would after the participation lock and before the
// guarded write. The write itself goes through the unwrapped transaction. `transaction` is wrapped
// as well, because the update to intercept is made on the transaction the service opens, and a
// wrapper that only covered `update` on the object passed in would never fire.
const withWriteBeforeFirstUpdateInTransaction = (
  tx: Tx,
  writeBeforeUpdate: () => Promise<void>,
): Tx => {
  let hasWritten = false;
  const runWriteOnce = async (): Promise<void> => {
    if (hasWritten) return;
    hasWritten = true;
    await writeBeforeUpdate();
  };

  const delayExecution = (chain: object): object =>
    new Proxy(chain, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === "then" && typeof value === "function") {
          return (resolve: (result: unknown) => void, reject: (reason: unknown) => void) =>
            runWriteOnce().then(() => Reflect.apply(value, target, [resolve, reject]), reject);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return typeof result === "object" && result !== null ? delayExecution(result) : result;
        };
      },
    });

  const delayFirstUpdate = (innerTx: Tx): Tx =>
    new Proxy(innerTx, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "update") return value.bind(target);
        return (...args: unknown[]) => delayExecution(Reflect.apply(value, target, args));
      },
    });

  return new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "transaction") return value.bind(target);
      return (callback: (innerTx: Tx) => Promise<unknown>, ...rest: unknown[]) =>
        Reflect.apply(value, target, [
          (innerTx: Tx) => callback(delayFirstUpdate(innerTx)),
          ...rest,
        ]);
    },
  });
};

describe.skipIf(skipWithoutDatabase)("the prizes of a draft competition", () => {
  it("replaces the list of a draft with no registration", async () => {
    await inRollback(async (tx) => {
      const seed = await seedDraftWithSavedPrizes(tx);

      const answer = await putPrizesVia(tx, seed, [SECOND_PRIZE]);

      expect({
        status: answer.status,
        titles: (await readPrizeRows(tx, seed.competitionId)).map((row) => row.title),
      }).toEqual({ status: 200, titles: ["Juara dua"] });
    });
  });

  it("saves a draft whose every registration is cancelled", async () => {
    await inRollback(async (tx) => {
      const seed = await seedDraftWithSavedPrizes(tx);
      await seedRegistration(tx, seed.competitionId, "cancelled");

      const answer = await putPrizesVia(tx, seed, [SECOND_PRIZE]);

      expect({
        status: answer.status,
        titles: (await readPrizeRows(tx, seed.competitionId)).map((row) => row.title),
      }).toEqual({ status: 200, titles: ["Juara dua"] });
    });
  });

  it.each(["confirmed", "pending_payment"] as const)(
    "refuses a draft holding a %s registration and leaves every prize row unchanged",
    async (registrationStatus) => {
      await inRollback(async (tx) => {
        const seed = await seedDraftWithSavedPrizes(tx);
        await seedRegistration(tx, seed.competitionId, registrationStatus);
        const before = await readPrizeRows(tx, seed.competitionId);

        const answer = await putPrizesVia(tx, seed, [SECOND_PRIZE]);

        expect({
          status: answer.status,
          code: errorOf(answer).code,
          message: errorOf(answer).message,
          rows: await readPrizeRows(tx, seed.competitionId),
        }).toEqual({
          status: 409,
          code: HELD_CODE,
          message: REGISTRATIONS_SENTENCE,
          rows: before,
        });
      });
    },
  );
});

describe.skipIf(skipWithoutDatabase)("the prizes of a published competition", () => {
  it.each([
    ["lowers a prize", [{ ...FIRST_PRIZE, cashAmount: 1_000_000 }, SECOND_PRIZE]],
    ["removes every prize", []],
    ["reorders the prizes", [SECOND_PRIZE, FIRST_PRIZE]],
    ["adds a prize", [...INITIAL_PRIZES, { ...SECOND_PRIZE, title: "Juara tiga" }]],
  ] as const)(
    "refuses a save that %s and leaves every prize row unchanged",
    async (_label, prizes) => {
      await inRollback(async (tx) => {
        const seed = await seedPublishedWithSavedPrizes(tx);
        const before = await readPrizeRows(tx, seed.competitionId);

        const answer = await putPrizesVia(tx, seed, [...prizes]);

        expect({
          status: answer.status,
          code: errorOf(answer).code,
          message: errorOf(answer).message,
          rows: await readPrizeRows(tx, seed.competitionId),
        }).toEqual({
          status: 409,
          code: LOCKED_CODE,
          message: LOCK_SENTENCE,
          rows: before,
        });
        expect(before).toHaveLength(2);
      });
    },
  );

  it("refuses a save for a publish that landed after the save began, and leaves every prize row unchanged", async () => {
    await inRollback(async (tx) => {
      const seed = await seedDraftWithSavedPrizes(tx);
      const before = await readPrizeRows(tx, seed.competitionId);
      const injectedPublishes: Array<{ id: string }> = [];
      const racingTx = withWriteBeforeFirstUpdateInTransaction(tx, async () => {
        const rows = await tx
          .update(competitions)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(competitions.id, seed.competitionId))
          .returning({ id: competitions.id });
        injectedPublishes.push(...rows);
      });

      const answer = await putPrizesVia(racingTx, seed, [SECOND_PRIZE]);

      // The injected publish sits inside the service's own transaction, which the refusal rolls
      // back, so the status is not read again here. The count shows the publish was injected.
      expect({
        injectedPublishes: injectedPublishes.length,
        status: answer.status,
        code: errorOf(answer).code,
        rows: await readPrizeRows(tx, seed.competitionId),
      }).toEqual({
        injectedPublishes: 1,
        status: 409,
        code: LOCKED_CODE,
        rows: before,
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the prizes read for the editor", () => {
  it("answers unlocked for a draft and locked once it is published", async () => {
    await inRollback(async (tx) => {
      const seed = await seedDraftWithSavedPrizes(tx);

      const draftAnswer = await getPrizesVia(tx, seed);
      const published = await publishVia(tx, seed);
      const publishedAnswer = await getPrizesVia(tx, seed);

      expect({
        draftLocked: draftAnswer.body.locked,
        published: published.status,
        publishedLocked: publishedAnswer.body.locked,
        publishedTitles: (publishedAnswer.body.prizes as Array<{ title: string }>).map(
          (prize) => prize.title,
        ),
      }).toEqual({
        draftLocked: false,
        published: 200,
        publishedLocked: true,
        publishedTitles: ["Juara satu", "Juara dua"],
      });
    });
  });
});
