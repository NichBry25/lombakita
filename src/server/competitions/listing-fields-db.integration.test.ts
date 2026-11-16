// @vitest-environment node
//
// THE LOCATION AND THE AUDIENCE OF A COMPETITION, THROUGH THE REAL ROUTES, AGAINST A REAL POSTGRES.
//
// Each test reaches the production route handler (PATCH, PUT or POST publish) with a Request, so
// the parse, the access check, the classifier and the write are all the code that runs in
// production. The seam is the two things a rolled-back transaction cannot answer: which database
// (the pooled client, not this transaction) and who is signed in. Every test runs inside a
// transaction that is always rolled back.
//
// Guards this suite pins, each one failing when the guard is removed:
//   - the classifier's block of a location move that drops a way of taking part, and of a value
//     to empty (competition-service.ts, edit-classification.ts)
//   - the eligibility save's draft-only emptying of a set audience
//   - the publish refusal of an empty location (checklist) and of an empty audience (its own gate)
//   - the publish write's own re-check of both, with the pre-checks stood down
//   - the access check on both write paths

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import {
  candidateProfiles,
  competitions,
  institutionMemberships,
  institutions,
  users,
  type CompetitionAudience,
  type CompetitionLocation,
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

// Hoisted for the reason the readiness suite gives: the auth adapter calls `getDb()` while this
// file's own imports are still being evaluated, before any module-scope `let` is assigned.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

const audienceGateState = vi.hoisted(() => ({ skipGate: false }));
const checklistState = vi.hoisted(() => ({ ignoreLocation: false }));

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

// One test stands in for a save that clears the audience after the publish gate read it, so the
// publish write's own re-check is the only guard left standing. Otherwise the real gate runs.
vi.mock("@/server/competitions/competition-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/competitions/competition-access")>();
  return {
    ...actual,
    assertCompetitionHasAudience: async (
      ...args: Parameters<typeof actual.assertCompetitionHasAudience>
    ): Promise<void> => {
      if (audienceGateState.skipGate) return;
      await actual.assertCompetitionHasAudience(...args);
    },
  };
});

// The other half of the same stand-in: the checklist stops naming an empty location, as if the
// location had been cleared after the checklist read the row.
vi.mock("@/server/competitions/competition-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/competitions/competition-core")>();
  return {
    ...actual,
    validatePublishChecklist: (
      ...args: Parameters<typeof actual.validatePublishChecklist>
    ): ReturnType<typeof actual.validatePublishChecklist> => {
      const result = actual.validatePublishChecklist(...args);
      if (!checklistState.ignoreLocation) return result;
      const failures = result.failures.filter((failure) => failure.field !== "location");
      return { passed: failures.length === 0, failures };
    },
  };
});

import { PATCH as patchCompetition } from "@/app/api/v1/competitions/[competitionId]/route";
import { PUT as putEligibility } from "@/app/api/v1/competitions/[competitionId]/eligibility/route";
import { POST as publishCompetition } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { createIndividualRegistration } from "@/server/registrations/registration-service";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
  routeState.actorUserId = null;
  audienceGateState.skipGate = false;
  checklistState.ignoreLocation = false;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

type SeedInput = {
  status: "draft" | "published";
  location: CompetitionLocation | null;
  audience: CompetitionAudience[] | null;
};

type Seed = {
  ownerId: string;
  institutionSlug: string;
  competitionId: string;
};

const seedOwner = async (
  tx: Tx,
  label: string,
): Promise<{ id: string; institutionId: string; slug: string }> => {
  const id = uniqueSuffix();
  const [owner] = await tx
    .insert(users)
    .values({
      email: `${label}_${id}@example.test`,
      username: `${label}_${id}`,
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
      slug: `${label}-inst-${id}`,
      institutionType: "company",
      displayName: `Lokasi dan untuk ${id}`,
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

const seedCompetition = async (tx: Tx, input: SeedInput): Promise<Seed> => {
  const owner = await seedOwner(tx, "listing_owner");
  const now = Date.now();
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: owner.institutionId,
      slug: `listing-comp-${uniqueSuffix()}`,
      title: "Kompetisi lokasi dan untuk",
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      minTeamSize: 1,
      maxTeamSize: 1,
      location: input.location,
      audience: input.audience,
      status: input.status,
      ...(input.status === "published" ? { publishedAt: new Date(now) } : {}),
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

const readStored = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({
      status: competitions.status,
      title: competitions.title,
      description: competitions.description,
      location: competitions.location,
      audience: competitions.audience,
      eligibilityNote: competitions.eligibilityNote,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!;
};

type RouteAnswer = { status: number; body: Record<string, unknown> };

const answerOf = async (response: Response): Promise<RouteAnswer> => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

const errorCodeOf = (answer: RouteAnswer): string | null =>
  (answer.body.error as { code?: string } | undefined)?.code ?? null;

const stageActor = (tx: Tx, actorUserId: string): void => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = actorUserId;
};

const jsonRequest = (method: string, url: string, actorUserId: string, body: unknown): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", "X-Expected-User-Id": actorUserId },
    body: JSON.stringify(body),
  });

const patchVia = async (
  tx: Tx,
  actorUserId: string,
  seed: Seed,
  payload: Record<string, unknown>,
): Promise<RouteAnswer> => {
  stageActor(tx, actorUserId);
  const request = jsonRequest(
    "PATCH",
    `https://lombakita.test/api/v1/competitions/${seed.competitionId}`,
    actorUserId,
    payload,
  );
  const response = await patchCompetition(request, {
    params: Promise.resolve({ competitionId: seed.competitionId }),
  });
  return answerOf(response);
};

const saveEligibilityVia = async (
  tx: Tx,
  actorUserId: string,
  seed: Seed,
  payload: Record<string, unknown>,
): Promise<RouteAnswer> => {
  stageActor(tx, actorUserId);
  const request = jsonRequest(
    "PUT",
    `https://lombakita.test/api/v1/competitions/${seed.competitionId}/eligibility`,
    actorUserId,
    payload,
  );
  const response = await putEligibility(request, {
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

const announcedFields = (): unknown[] =>
  enqueueSpies.enqueueCompetitionEdited.mock.calls.map(
    ([input]) => (input as { changedFields: string[] }).changedFields,
  );

describe.skipIf(skipWithoutDatabase)("a legacy published competition", () => {
  const LEGACY: SeedInput = { status: "published", location: null, audience: null };

  it("accepts the edit the editor sends, which leaves the unchanged location out", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, LEGACY);

      const answer = await patchVia(tx, seed.ownerId, seed, {
        description: "Deskripsi baru untuk peserta.",
      });

      expect({
        status: answer.status,
        stored: await readStored(tx, seed.competitionId),
      }).toEqual({
        status: 200,
        stored: expect.objectContaining({
          description: "Deskripsi baru untuk peserta.",
          location: null,
          audience: null,
        }),
      });
    });
  });

  it("accepts an edit from an editor tab that still sends a null location", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, LEGACY);

      const answer = await patchVia(tx, seed.ownerId, seed, {
        description: "Deskripsi dari tab lama.",
        location: null,
      });

      expect(answer.status).toBe(200);
      expect(await readStored(tx, seed.competitionId)).toMatchObject({
        description: "Deskripsi dari tab lama.",
        location: null,
      });
    });
  });

  it("fills the location on a first edit and tells registrants where it takes place", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, LEGACY);

      const answer = await patchVia(tx, seed.ownerId, seed, { location: "offline" });

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).location,
        announced: announcedFields(),
      }).toEqual({ status: 200, stored: "offline", announced: [["location"]] });
    });
  });

  it("saves the note with an empty audience, because an empty one may stay empty", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, LEGACY);

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: "Catatan baru.",
        audience: [],
      });

      expect(answer.status).toBe(200);
      expect(await readStored(tx, seed.competitionId)).toMatchObject({
        eligibilityNote: "Catatan baru.",
        audience: null,
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the location of a published competition", () => {
  const BLOCKED_MOVES: Array<[CompetitionLocation, CompetitionLocation | null]> = [
    ["online", "offline"],
    ["offline", "online"],
    ["hybrid", "online"],
    ["hybrid", "offline"],
    ["online", null],
    ["offline", null],
    ["hybrid", null],
  ];

  it.each(BLOCKED_MOVES)("refuses %s → %s and writes nothing", async (from, to) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: from,
        audience: ["umum"],
      });

      const answer = await patchVia(tx, seed.ownerId, seed, { location: to });

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        stored: (await readStored(tx, seed.competitionId)).location,
        announced: announcedFields(),
      }).toEqual({
        status: 422,
        code: "competition_post_publish_blocked",
        stored: from,
        announced: [],
      });
    });
  });

  it.each([
    ["online", "hybrid"],
    ["offline", "hybrid"],
  ] as const)("saves %s → %s and announces it", async (from, to) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: from,
        audience: ["umum"],
      });

      const answer = await patchVia(tx, seed.ownerId, seed, { location: to });

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).location,
        announced: announcedFields(),
      }).toEqual({ status: 200, stored: to, announced: [["location"]] });
    });
  });

  it("moves freely on a draft, whatever it held", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "online",
        audience: null,
      });

      const answer = await patchVia(tx, seed.ownerId, seed, { location: "offline" });

      expect(answer.status).toBe(200);
      expect((await readStored(tx, seed.competitionId)).location).toBe("offline");
    });
  });

  it("refuses a location outside the enum", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: null,
        audience: null,
      });

      const answer = await patchVia(tx, seed.ownerId, seed, { location: "mars" });

      const stored = (await readStored(tx, seed.competitionId)).location;
      expect({ status: answer.status, stored }).toEqual({ status: 400, stored: null });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the audience save of the eligibility part", () => {
  it("stores the ticked values in the fixed order, once each", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "draft", location: null, audience: null });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: null,
        audience: ["smp", "umum", "smp", "mahasiswa"],
      });

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).audience,
      }).toEqual({ status: 200, stored: ["umum", "mahasiswa", "smp"] });
    });
  });

  it("empties a draft's audience to NULL and never to an empty array", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "online",
        audience: ["mahasiswa"],
      });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: null,
        audience: [],
      });

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).audience,
      }).toEqual({ status: 200, stored: null });
    });
  });

  it("refuses to empty the audience of a published competition and keeps it", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: "online",
        audience: ["mahasiswa"],
      });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: "Tidak boleh tersimpan.",
        audience: [],
      });

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        stored: await readStored(tx, seed.competitionId),
      }).toEqual({
        status: 409,
        code: "competition_changed_during_edit",
        stored: expect.objectContaining({ audience: ["mahasiswa"], eligibilityNote: null }),
      });
    });
  });

  it("changes the audience of a published competition when something stays ticked", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: "online",
        audience: ["mahasiswa"],
      });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: null,
        audience: ["sma_smk"],
      });

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).audience,
      }).toEqual({ status: 200, stored: ["sma_smk"] });
    });
  });

  it("leaves the audience alone when the request has no audience key", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: "online",
        audience: ["mahasiswa", "smp"],
      });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, {
        eligibilityNote: "Dari tab lama.",
      });

      expect({
        status: answer.status,
        stored: await readStored(tx, seed.competitionId),
      }).toEqual({
        status: 200,
        stored: expect.objectContaining({
          audience: ["mahasiswa", "smp"],
          eligibilityNote: "Dari tab lama.",
        }),
      });
    });
  });

  it.each([
    ["an unknown value", { audience: ["mahasiswa", "dosen"] }],
    ["a string instead of a list", { audience: "mahasiswa" }],
  ])("refuses %s and writes nothing", async (_name, payload) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: null,
        audience: ["umum"],
      });

      const answer = await saveEligibilityVia(tx, seed.ownerId, seed, payload);

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).audience,
      }).toEqual({ status: 400, stored: ["umum"] });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("publishing a draft", () => {
  it("is refused for an empty location, which the checklist names", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: null,
        audience: ["umum"],
      });

      const answer = await publishVia(tx, seed);

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        failedFields: (
          (answer.body.error as { details?: { fields?: string[] } }).details?.fields ?? []
        ).sort(),
        stored: (await readStored(tx, seed.competitionId)).status,
      }).toEqual({
        status: 422,
        code: "competition_publish_validation_failed",
        failedFields: ["location"],
        stored: "draft",
      });
    });
  });

  it.each([
    ["no audience", null],
    ["an empty audience array", []],
  ] as const)("is refused for %s, which has its own refusal", async (_name, audience) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "online",
        audience: audience === null ? null : [...audience],
      });

      const answer = await publishVia(tx, seed);

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        stored: (await readStored(tx, seed.competitionId)).status,
      }).toEqual({ status: 422, code: "competition_audience_missing", stored: "draft" });
    });
  });

  it("is refused for both empty, by the checklist before the audience gate", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "draft", location: null, audience: null });

      const answer = await publishVia(tx, seed);

      expect({ status: answer.status, code: errorCodeOf(answer) }).toEqual({
        status: 422,
        code: "competition_publish_validation_failed",
      });
    });
  });

  it("goes live with both set", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "hybrid",
        audience: ["mahasiswa", "smp"],
      });

      const answer = await publishVia(tx, seed);

      expect({
        status: answer.status,
        stored: (await readStored(tx, seed.competitionId)).status,
      }).toEqual({ status: 200, stored: "published" });
    });
  });

  it("stays a draft when the audience is cleared after the gate read it", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "online",
        audience: null,
      });
      audienceGateState.skipGate = true;

      const answer = await publishVia(tx, seed);

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        stored: (await readStored(tx, seed.competitionId)).status,
      }).toEqual({ status: 422, code: "competition_invalid_transition", stored: "draft" });
    });
  });

  it("stays a draft when the location is cleared after the checklist read it", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: null,
        audience: ["umum"],
      });
      checklistState.ignoreLocation = true;

      const answer = await publishVia(tx, seed);

      expect({
        status: answer.status,
        code: errorCodeOf(answer),
        stored: (await readStored(tx, seed.competitionId)).status,
      }).toEqual({ status: 422, code: "competition_invalid_transition", stored: "draft" });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("who may write the location and the audience", () => {
  it("refuses a member of another institution on both write paths", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "draft",
        location: "online",
        audience: ["umum"],
      });
      const outsider = await seedOwner(tx, "listing_outsider");

      const patched = await patchVia(tx, outsider.id, seed, { location: "offline" });
      const saved = await saveEligibilityVia(tx, outsider.id, seed, {
        eligibilityNote: null,
        audience: ["sd"],
      });

      expect({
        patched: patched.status >= 400,
        saved: saved.status >= 400,
        stored: await readStored(tx, seed.competitionId),
      }).toEqual({
        patched: true,
        saved: true,
        stored: expect.objectContaining({ location: "online", audience: ["umum"] }),
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("registration and the audience", () => {
  it("lets a university student register for a competition tagged SMA/SMK", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, {
        status: "published",
        location: "online",
        audience: ["sma_smk"],
      });
      const candidateKey = uniqueSuffix();
      const [candidate] = await tx
        .insert(users)
        .values({
          email: `listing_candidate_${candidateKey}@example.test`,
          username: `listing_candidate_${candidateKey}`,
          emailVerified: new Date(),
          candidateVerifiedAt: new Date(),
        })
        .returning({ id: users.id });
      await tx.insert(candidateProfiles).values({
        userId: candidate!.id,
        fullName: "Mahasiswa Contoh",
        phoneNumber: "081234567890",
        occupation: "college_student",
        dateOfBirth: "2004-05-01",
      });

      const registration = await createIndividualRegistration(
        candidate!.id,
        seed.competitionId,
        tx as unknown as Database,
      );

      expect(registration.status).toBe("confirmed");
    });
  });
});
