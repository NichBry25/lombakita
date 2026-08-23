// @vitest-environment node
//
// The ownership collapse on a candidate's document-request upload, against a real Postgres.
//
// registration-document-service.test.ts drives this function with a MOCKED db whose `select`
// returns whatever the test handed it, so removing the ownership predicate from the query would
// not change a single result there. The predicate lives in SQL, so only the database can say
// whether it holds — which is what makes this file the detector for r2-flows' DOC-10 rather than
// the mocked suite next to it.
//
// The guarantee: `loadRequestForCandidate` scopes its query by the caller's own registration, so a
// request belonging to someone else yields no row and EXISTENCE COLLAPSES INTO OWNERSHIP. A
// foreign id is indistinguishable from a missing one, which is what stops the endpoint enumerating
// other candidates' requests. A 403 here would confirm the request exists.
//
// Every test runs inside a transaction that is ALWAYS rolled back. The R2 client is mocked because
// the guard under test is a database predicate and storage has nothing to do with it; the database
// is real because the guard is.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedPutUrl: vi.fn(async () => "https://r2.example/put"),
  listObjects: vi.fn(async () => []),
  deleteObject: vi.fn(async () => undefined),
  headObject: vi.fn(async () => ({ contentLength: 1 })),
}));

import { TransactionRollbackError } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  users,
} from "@/server/db/schema";
import {
  RegistrationDocumentError,
  parseDocumentFileDeclaration,
  parseDocumentRequestInput,
} from "@/server/registration-documents/registration-document-core";
import {
  createDocumentRequest,
  prepareRequestDocumentUpload,
} from "@/server/registration-documents/registration-document-service";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const DUE = new Date("2026-02-14T00:00:00.000Z");

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

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

const FILE = parseDocumentFileDeclaration({
  originalFileName: "kartu-pelajar.png",
  contentType: "image/png",
  fileSizeBytes: 4096,
});

type Fixture = {
  requestId: string;
  ownerId: string;
  strangerId: string;
};

/**
 * Seeds two candidates registered to the same competition and raises a document request against
 * ONE of them through `createDocumentRequest` — the same call the organiser's route makes.
 *
 * Built through the production path on purpose: a hand-inserted request row would prove the query
 * and say nothing about whether the row the product creates is the shape the query scopes on.
 */
const seedForeignRequest = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();

  const insertUser = async (label: string): Promise<string> => {
    const [row] = await tx
      .insert(users)
      .values({
        email: `docown_${label}_${id}@example.test`,
        username: `docown_${label}_${id}`,
        // users_one_verified_role_chk requires at least one verified role.
        candidateVerifiedAt: NOW,
      })
      .returning({ id: users.id });
    return row!.id;
  };

  const ownerId = await insertUser("owner");
  const strangerId = await insertUser("stranger");
  const organiserId = await insertUser("organiser");

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `docown-inst-${id}`,
      // institutions_display_name_type_chk allows a null display name only for `personal`.
      institutionType: "personal",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: organiserId,
    membershipRole: "institution_owner",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `docown-comp-${id}`,
      title: `Ownership fixture ${id}`,
    })
    .returning({ id: competitions.id });

  const registrationFor = async (studentId: string): Promise<string> => {
    const [row] = await tx
      .insert(competitionRegistrations)
      .values({
        competitionId: competition!.id,
        studentId,
        // competition_registrations_type_team_id_chk: individual requires a null team_id.
        registrationType: "individual",
      })
      .returning({ id: competitionRegistrations.id });
    return row!.id;
  };

  const ownerRegistrationId = await registrationFor(ownerId);
  // The stranger is a genuine participant in the same competition. Without this the test would
  // also pass for a guard that merely checked "is this person registered at all".
  await registrationFor(strangerId);

  const { requestId } = await createDocumentRequest(
    institution!.id,
    competition!.id,
    organiserId,
    ownerRegistrationId,
    parseDocumentRequestInput(
      { title: "Kartu pelajar", instructions: null, dueAt: DUE.toISOString() },
      NOW,
    ),
    tx as never,
    NOW,
  );

  return { requestId, ownerId, strangerId };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(skipWithoutDatabase)(
  "prepareRequestDocumentUpload ownership (real database)",
  () => {
    // The positive control. Without it, a guard that refused EVERY caller would pass the test below
    // while breaking the feature outright.
    it("lets the candidate the request was raised against presign an upload", async () => {
      await inRollback(async (tx) => {
        const { requestId, ownerId } = await seedForeignRequest(tx);

        const prepared = await prepareRequestDocumentUpload(ownerId, requestId, FILE, tx as never);

        expect(prepared.uploadUrl).toBe("https://r2.example/put");
      });
    });

    it("refuses another candidate with a 404 that does not admit the request exists", async () => {
      await inRollback(async (tx) => {
        const { requestId, strangerId } = await seedForeignRequest(tx);

        const attempt = prepareRequestDocumentUpload(strangerId, requestId, FILE, tx as never);

        await expect(attempt).rejects.toBeInstanceOf(RegistrationDocumentError);
        await attempt.catch((error: unknown) => {
          const failure = error as RegistrationDocumentError;
          expect(failure.httpStatus).toBe(404);
          expect(failure.code).toBe("document_request_not_found");
        });
      });
    });

    it("refuses an id that belongs to nobody with the identical answer", async () => {
      await inRollback(async (tx) => {
        const { strangerId } = await seedForeignRequest(tx);

        const attempt = prepareRequestDocumentUpload(
          strangerId,
          "00000000-0000-4000-8000-000000000000",
          FILE,
          tx as never,
        );

        await attempt.catch((error: unknown) => {
          const failure = error as RegistrationDocumentError;
          expect(failure.httpStatus).toBe(404);
          expect(failure.code).toBe("document_request_not_found");
        });
        await expect(attempt).rejects.toBeInstanceOf(RegistrationDocumentError);
      });
    });
  },
);
