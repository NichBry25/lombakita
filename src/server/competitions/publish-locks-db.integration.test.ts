// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitions,
  financeFeeDisclosureAcknowledgements,
  financeFeeRules,
  institutionMemberships,
  institutionPaymentInstructions,
  institutions,
  users,
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

const enqueueSpies = vi.hoisted(() => ({
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

import {
  CompetitionError,
  parseCompetitionPatchInput,
} from "@/server/competitions/competition-core";
import { updateCompetitionDraft } from "@/server/competitions/competition-service";
import {
  setCompetitionFee,
  setCompetitionPaymentWindow,
} from "@/server/competitions/competition-fee-service";

beforeEach(() => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const PRICE_REASON = "Biaya pendaftaran tidak dapat diubah setelah kompetisi terbit.";
const HOUR_MS = 60 * 60 * 1000;

type Seed = {
  ownerId: string;
  competitionId: string;
  slug: string;
  registrationEndAt: Date;
  eventStartAt: Date;
};

const seedCompetition = async (
  tx: Tx,
  input: { status: "draft" | "published"; paid: boolean },
): Promise<Seed> => {
  const id = uniqueSuffix();
  const ownerUsername = `publock_owner_${id}`;
  const [owner] = await tx
    .insert(users)
    .values({
      email: `${ownerUsername}@example.test`,
      username: ownerUsername,
      emailVerified: new Date(),
      role: "recruiter",
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `publock-inst-${id}`,
      institutionType: "company",
      displayName: `Kunci Terbit ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: owner!.id,
    membershipRole: "institution_owner",
    status: "active",
  });
  await tx.insert(institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });
  await tx.insert(financeFeeRules).values({
    institutionId: institution!.id,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(Date.now() - 30 * DAY_MS),
  });

  const now = Date.now();
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `publock-comp-${id}`,
      title: `Kompetisi kunci ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: 3,
      maxTeamSize: 4,
      status: input.status,
      ...(input.status === "published" ? { publishedAt: new Date(now) } : {}),
      registrationStartAt: new Date(now - 7 * DAY_MS),
      registrationEndAt: new Date(now + 14 * DAY_MS),
      participantConfirmationAt: new Date(now + 20 * DAY_MS),
      eventStartAt: new Date(now + 30 * DAY_MS),
      eventEndAt: new Date(now + 31 * DAY_MS),
      resultAnnouncementAt: new Date(now + 40 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 3,
      feeAmount: input.paid ? 150_000 : null,
      feeCurrency: input.paid ? "IDR" : null,
      paymentWindowDays: 3,
    })
    .returning({
      id: competitions.id,
      slug: competitions.slug,
      registrationEndAt: competitions.registrationEndAt,
      eventStartAt: competitions.eventStartAt,
    });

  return {
    ownerId: owner!.id,
    competitionId: competition!.id,
    slug: competition!.slug,
    registrationEndAt: competition!.registrationEndAt!,
    eventStartAt: competition!.eventStartAt!,
  };
};

const readStored = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({
      slug: competitions.slug,
      mode: competitions.mode,
      minTeamSize: competitions.minTeamSize,
      maxTeamSize: competitions.maxTeamSize,
      registrationEndAt: competitions.registrationEndAt,
      eventStartAt: competitions.eventStartAt,
      allowCancellation: competitions.allowCancellation,
      cancellationCutoffDays: competitions.cancellationCutoffDays,
      description: competitions.description,
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      paymentWindowDays: competitions.paymentWindowDays,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return {
    ...row!,
    registrationEndAt: row!.registrationEndAt!.getTime(),
    eventStartAt: row!.eventStartAt!.getTime(),
  };
};

type StoredCompetition = Awaited<ReturnType<typeof readStored>>;

const countAcknowledgements = async (tx: Tx, competitionId: string): Promise<number> => {
  const [row] = await tx
    .select({ total: count() })
    .from(financeFeeDisclosureAcknowledgements)
    .where(eq(financeFeeDisclosureAcknowledgements.competitionId, competitionId));
  return row!.total;
};

const announcedFields = (): unknown[] =>
  enqueueSpies.enqueueCompetitionEdited.mock.calls.map(
    ([input]) => (input as { changedFields: string[] }).changedFields,
  );

const refusalOf = async (
  work: Promise<unknown>,
): Promise<{ code: string; httpStatus: number; message: string; fields?: string[] } | null> => {
  try {
    await work;
    return null;
  } catch (error) {
    if (!(error instanceof CompetitionError)) throw error;
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      message: error.message,
      fields: error.details?.fields,
    };
  }
};

const isoShiftedBy = (date: Date, ms: number): string =>
  new Date(date.getTime() + ms).toISOString();

const editVia = (tx: Tx, seed: Seed, payload: Record<string, unknown>) =>
  updateCompetitionDraft(
    seed.ownerId,
    seed.competitionId,
    parseCompetitionPatchInput(payload),
    tx as unknown as Database,
  );

const priceVia = (tx: Tx, seed: Seed, input: Parameters<typeof setCompetitionFee>[2]) =>
  setCompetitionFee(seed.ownerId, seed.competitionId, input, tx as unknown as Database, new Date());

const REFUSED_EDITS: Array<{
  name: string;
  payload: (seed: Seed) => Record<string, unknown>;
  code: string;
  fields: string[];
}> = [
  {
    name: "a raised team minimum",
    payload: () => ({ minTeamSize: 4 }),
    code: "competition_post_publish_blocked",
    fields: ["minTeamSize"],
  },
  {
    name: "a lowered team maximum",
    payload: () => ({ maxTeamSize: 3 }),
    code: "competition_post_publish_blocked",
    fields: ["maxTeamSize"],
  },
  {
    name: "an earlier registration close",
    payload: (seed) => ({ registrationEndAt: isoShiftedBy(seed.registrationEndAt, -4 * DAY_MS) }),
    code: "competition_post_publish_blocked",
    fields: ["registrationEndAt"],
  },
  {
    name: "an earlier event start",
    payload: (seed) => ({ eventStartAt: isoShiftedBy(seed.eventStartAt, -5 * DAY_MS) }),
    code: "competition_post_publish_blocked",
    fields: ["eventStartAt"],
  },
  {
    name: "withdrawal turned off",
    payload: () => ({ allowCancellation: false, cancellationCutoffDays: null }),
    code: "competition_post_publish_blocked",
    fields: ["allowCancellation"],
  },
  {
    name: "a larger cancellation cutoff",
    payload: () => ({ cancellationCutoffDays: 5 }),
    code: "competition_post_publish_blocked",
    fields: ["cancellationCutoffDays"],
  },
  {
    name: "a new slug",
    payload: (seed) => ({ slug: `${seed.slug}-baru` }),
    code: "competition_post_publish_blocked",
    fields: ["slug"],
  },
  {
    name: "a new mode",
    payload: () => ({ mode: "both", maxTeamSize: 4 }),
    code: "competition_field_immutable",
    fields: ["mode"],
  },
];

const ANNOUNCED_EDITS: Array<{
  name: string;
  payload: (seed: Seed) => Record<string, unknown>;
  field: string;
  stored: (seed: Seed) => Partial<StoredCompetition>;
}> = [
  {
    name: "a lowered team minimum",
    payload: () => ({ minTeamSize: 2 }),
    field: "minTeamSize",
    stored: () => ({ minTeamSize: 2 }),
  },
  {
    name: "a raised team maximum",
    payload: () => ({ maxTeamSize: 6 }),
    field: "maxTeamSize",
    stored: () => ({ maxTeamSize: 6 }),
  },
  {
    name: "a later registration close",
    payload: (seed) => ({ registrationEndAt: isoShiftedBy(seed.registrationEndAt, 4 * DAY_MS) }),
    field: "registrationEndAt",
    stored: (seed) => ({ registrationEndAt: seed.registrationEndAt.getTime() + 4 * DAY_MS }),
  },
  {
    name: "a later event start",
    payload: (seed) => ({ eventStartAt: isoShiftedBy(seed.eventStartAt, 12 * HOUR_MS) }),
    field: "eventStartAt",
    stored: (seed) => ({ eventStartAt: seed.eventStartAt.getTime() + 12 * HOUR_MS }),
  },
  {
    name: "a smaller cancellation cutoff",
    payload: () => ({ cancellationCutoffDays: 1 }),
    field: "cancellationCutoffDays",
    stored: () => ({ cancellationCutoffDays: 1 }),
  },
  {
    name: "a new description",
    payload: () => ({ description: "Deskripsi baru untuk peserta." }),
    field: "description",
    stored: () => ({ description: "Deskripsi baru untuk peserta." }),
  },
];

describe.skipIf(skipWithoutDatabase)("an edit to a published competition", () => {
  it.each(REFUSED_EDITS)("refuses $name and writes nothing", async ({ payload, code, fields }) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: false });
      const before = await readStored(tx, seed.competitionId);

      const refusal = await refusalOf(editVia(tx, seed, payload(seed)));

      expect({
        refusal,
        stored: await readStored(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        refusal: { code, httpStatus: 422, message: expect.any(String), fields },
        stored: before,
        announced: [],
      });
    });
  });

  it.each(ANNOUNCED_EDITS)("saves and announces $name", async ({ payload, field, stored }) => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: false });
      const before = await readStored(tx, seed.competitionId);

      await editVia(tx, seed, payload(seed));

      expect({
        stored: await readStored(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: { ...before, ...stored(seed) },
        announced: [[field]],
      });
    });
  });

  it("keeps every edit on a draft, those publishing locks included", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "draft", paid: false });
      const before = await readStored(tx, seed.competitionId);

      await editVia(tx, seed, {
        slug: `${seed.slug}-baru`,
        mode: "both",
        maxTeamSize: 3,
        registrationEndAt: isoShiftedBy(seed.registrationEndAt, -4 * DAY_MS),
        eventStartAt: isoShiftedBy(seed.eventStartAt, -5 * DAY_MS),
        allowCancellation: false,
        cancellationCutoffDays: null,
      });

      expect({
        stored: await readStored(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: {
          ...before,
          slug: `${seed.slug}-baru`,
          mode: "both",
          minTeamSize: 1,
          maxTeamSize: 3,
          registrationEndAt: seed.registrationEndAt.getTime() - 4 * DAY_MS,
          eventStartAt: seed.eventStartAt.getTime() - 5 * DAY_MS,
          allowCancellation: false,
          cancellationCutoffDays: null,
        },
        announced: [],
      });
    });
  });

  it("keeps a raised team minimum and a larger cutoff on a draft", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "draft", paid: false });
      const before = await readStored(tx, seed.competitionId);

      await editVia(tx, seed, { minTeamSize: 4, cancellationCutoffDays: 5 });

      expect({
        stored: await readStored(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: { ...before, minTeamSize: 4, cancellationCutoffDays: 5 },
        announced: [],
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the price of a published competition", () => {
  it("refuses a new price on a published competition and writes nothing", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: true });
      const before = await readStored(tx, seed.competitionId);

      const refusal = await refusalOf(
        priceVia(tx, seed, {
          feeAmount: 200_000,
          feeCurrency: "IDR",
          feeDisclosureAcknowledged: true,
        }),
      );

      expect({
        refusal,
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        refusal: {
          code: "competition_fee_locked_after_publish",
          httpStatus: 409,
          message: PRICE_REASON,
          fields: ["feeAmount"],
        },
        stored: before,
        acknowledgements: 0,
        announced: [],
      });
    });
  });

  it("refuses clearing the fee of a published competition and writes nothing", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: true });
      const before = await readStored(tx, seed.competitionId);

      const refusal = await refusalOf(priceVia(tx, seed, { feeAmount: 0, feeCurrency: null }));

      expect({
        refusal,
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        refusal: {
          code: "competition_fee_locked_after_publish",
          httpStatus: 409,
          message: PRICE_REASON,
          fields: ["feeAmount", "feeCurrency"],
        },
        stored: before,
        acknowledgements: 0,
        announced: [],
      });
    });
  });

  it("refuses a new currency on a published competition and writes nothing", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: true });
      const before = await readStored(tx, seed.competitionId);

      const refusal = await refusalOf(
        priceVia(tx, seed, {
          feeAmount: 150_000,
          feeCurrency: "USD",
          feeDisclosureAcknowledged: true,
        }),
      );

      expect({
        refusal,
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        refusal: {
          code: "competition_fee_locked_after_publish",
          httpStatus: 409,
          message: PRICE_REASON,
          fields: ["feeCurrency"],
        },
        stored: before,
        acknowledgements: 0,
        announced: [],
      });
    });
  });

  it("refuses a first price on a free published competition and writes nothing", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: false });
      const before = await readStored(tx, seed.competitionId);

      const refusal = await refusalOf(
        priceVia(tx, seed, {
          feeAmount: 150_000,
          feeCurrency: "IDR",
          feeDisclosureAcknowledged: true,
        }),
      );

      expect({
        refusal,
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        refusal: {
          code: "competition_fee_locked_after_publish",
          httpStatus: 409,
          message: PRICE_REASON,
          fields: ["feeAmount", "feeCurrency"],
        },
        stored: before,
        acknowledgements: 0,
        announced: [],
      });
    });
  });

  it("still moves the payment window of a published competition and announces it", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: true });
      const before = await readStored(tx, seed.competitionId);

      await setCompetitionPaymentWindow(
        seed.ownerId,
        seed.competitionId,
        5,
        tx as unknown as Database,
      );

      expect({
        stored: await readStored(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: { ...before, paymentWindowDays: 5 },
        announced: [["paymentWindowDays"]],
      });
    });
  });

  it("takes the unchanged price of a published competition with a new window through the price path", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "published", paid: true });
      const before = await readStored(tx, seed.competitionId);

      await priceVia(tx, seed, {
        feeAmount: 150_000,
        feeCurrency: "IDR",
        paymentWindowDays: 5,
        feeDisclosureAcknowledged: true,
      });

      expect({
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: { ...before, paymentWindowDays: 5 },
        acknowledgements: 1,
        announced: [["paymentWindowDays"]],
      });
    });
  });

  it("still prices a draft", async () => {
    await inRollback(async (tx) => {
      const seed = await seedCompetition(tx, { status: "draft", paid: false });
      const before = await readStored(tx, seed.competitionId);

      await priceVia(tx, seed, {
        feeAmount: 150_000,
        feeCurrency: "IDR",
        feeDisclosureAcknowledged: true,
      });

      expect({
        stored: await readStored(tx, seed.competitionId),
        acknowledgements: await countAcknowledgements(tx, seed.competitionId),
        announced: announcedFields(),
      }).toEqual({
        stored: { ...before, feeAmount: 150_000, feeCurrency: "IDR" },
        acknowledgements: 1,
        announced: [],
      });
    });
  });
});
