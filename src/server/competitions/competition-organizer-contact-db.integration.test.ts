// @vitest-environment node
//
// The contact a host sets for participants, against a real Postgres, through the real routes: the
// contact route's GET and PUT, the publish route, and the public detail read. The seams are the
// readiness suite's two (which database and who is signed in) plus the two queue calls, so a test
// can see that a live competition's contact change sends no notice.
//
// Every test runs inside a transaction that is always rolled back.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  notifications,
  recruiterVerificationSubmissions,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";

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

// In `vi.hoisted` because the routes reach `auth.config.ts`, which calls `getDb()` while this file
// is still initialising (see competition-publish-readiness-db.integration.test.ts).
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

const queueMocks = vi.hoisted(() => ({
  enqueueCompetitionEdited: vi.fn(async () => ({})),
  enqueueCompetitionSearchSync: vi.fn(async () => ({})),
}));

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
    if (!routeState.actorUserId) {
      throw new Error("a route ran with no session staged");
    }
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  enqueueCompetitionEdited: queueMocks.enqueueCompetitionEdited,
  enqueueCompetitionSearchSync: queueMocks.enqueueCompetitionSearchSync,
}));

import {
  GET as getContactRoute,
  PUT as putContactRoute,
} from "@/app/api/v1/competitions/[competitionId]/contact/route";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
  routeState.actorUserId = null;
  queueMocks.enqueueCompetitionEdited.mockClear();
  queueMocks.enqueueCompetitionSearchSync.mockClear();
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const DAY = 24 * 60 * 60 * 1000;

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

type ContactInput = { kind: "whatsapp" | "phone" | "email"; value: string };
type SeededUser = { id: string; email: string };
type SeededInstitution = { id: string; slug: string };
type SeededCompetition = { id: string; slug: string };

const seedUser = async (
  tx: Tx,
  options: { tier?: "minimal" | "elevated"; role?: "recruiter" | "candidate" } = {},
): Promise<SeededUser> => {
  const suffix = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `contact_${suffix}@example.test`,
      username: `contact_${suffix}`,
      role: options.role ?? "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: options.tier ?? "elevated",
    })
    .returning({ id: users.id, email: users.email });
  return { id: row!.id, email: row!.email };
};

const seedInstitution = async (tx: Tx): Promise<SeededInstitution> => {
  const suffix = uniqueSuffix();
  const [row] = await tx
    .insert(institutions)
    .values({
      slug: `contact-inst-${suffix}`,
      institutionType: "company",
      displayName: `Contact Fixture ${suffix}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: "pending_verification",
    })
    .returning({ id: institutions.id, slug: institutions.slug });
  return { id: row!.id, slug: row!.slug };
};

const addMember = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
): Promise<void> => {
  await tx
    .insert(institutionMemberships)
    .values({ institutionId, userId, membershipRole, status: "active" });
};

const seedCompetition = async (
  tx: Tx,
  institutionId: string,
  options: { status?: "draft" | "published"; contact?: ContactInput } = {},
): Promise<SeededCompetition> => {
  const suffix = uniqueSuffix();
  const status = options.status ?? "draft";
  const [row] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `contact-comp-${suffix}`,
      title: `Contact Fixture ${suffix}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      location: "online",
      audience: ["umum"],
      status,
      publishedAt: status === "published" ? new Date() : null,
      ...validTimeline(),
      organizerContactKind: options.contact?.kind ?? null,
      organizerContactValue: options.contact?.value ?? null,
    })
    .returning({ id: competitions.id, slug: competitions.slug });
  return { id: row!.id, slug: row!.slug };
};

const seedSignup = async (
  tx: Tx,
  userId: string,
  mobileNumber: string,
  status: "draft" | "pending_review" | "approved" | "rejected",
  submittedAt: Date,
): Promise<void> => {
  await tx.insert(recruiterVerificationSubmissions).values({
    userId,
    fullName: "Budi Santoso",
    mobileNumber,
    status,
    submittedAt,
    firstSubmittedAt: submittedAt,
  });
};

const readContact = async (
  tx: Tx,
  competitionId: string,
): Promise<{ kind: string | null; value: string | null }> => {
  const [row] = await tx
    .select({
      kind: competitions.organizerContactKind,
      value: competitions.organizerContactValue,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);
  return row!;
};

const readStatus = async (tx: Tx, competitionId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: competitions.status })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);
  return row!.status;
};

const stage = (tx: Tx, actorUserId: string): void => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = actorUserId;
};

type RouteAnswer = { status: number; body: Record<string, unknown> };

const getContact = async (
  tx: Tx,
  actorUserId: string,
  competitionId: string,
): Promise<RouteAnswer> => {
  stage(tx, actorUserId);
  const request = new Request(
    `https://lombakita.test/api/v1/competitions/${competitionId}/contact`,
  );
  const response = await getContactRoute(request, {
    params: Promise.resolve({ competitionId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const putContact = async (
  tx: Tx,
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  expectedUserId: string = actorUserId,
): Promise<RouteAnswer> => {
  stage(tx, actorUserId);
  const request = new Request(
    `https://lombakita.test/api/v1/competitions/${competitionId}/contact`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Expected-User-Id": expectedUserId },
      body: JSON.stringify(payload),
    },
  );
  const response = await putContactRoute(request, {
    params: Promise.resolve({ competitionId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const errorCodeOf = (answer: RouteAnswer): string | undefined =>
  (answer.body.error as { code?: string } | undefined)?.code;

const publish = async (
  tx: Tx,
  actorUserId: string,
  institution: SeededInstitution,
  competition: SeededCompetition,
): Promise<RouteAnswer> => {
  stage(tx, actorUserId);
  const request = new Request(
    `https://lombakita.test/api/v1/institutions/${institution.slug}/competitions/${competition.id}/publish`,
    { method: "POST", headers: { "X-Expected-User-Id": actorUserId } },
  );
  const response = await publishRoute(request, {
    params: Promise.resolve({ institutionSlug: institution.slug, competitionId: competition.id }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe.skipIf(skipWithoutDatabase)("the contact route against a real database", () => {
  it("saves a WhatsApp contact for the owner as digits in 62 form", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id);

      const answer = await putContact(tx, owner.id, competition.id, {
        kind: "whatsapp",
        value: "0812-3456-7890",
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ contact: { kind: "whatsapp", value: "6281234567890" } });
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "whatsapp",
        value: "6281234567890",
      });
    });
  });

  it("lets a staff member of the institution change the contact", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const staff = await seedUser(tx);
      await addMember(tx, institution.id, staff.id, "institution_staff");
      const competition = await seedCompetition(tx, institution.id, {
        status: "published",
        contact: { kind: "phone", value: "6281111111111" },
      });

      const answer = await putContact(tx, staff.id, competition.id, {
        kind: "phone",
        value: "+62 811 2222 3333",
      });

      expect(answer.status).toBe(200);
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "phone",
        value: "6281122223333",
      });
    });
  });

  it("refuses a plain member and leaves the contact as it was", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const member = await seedUser(tx);
      await addMember(tx, institution.id, member.id, "institution_member");
      const competition = await seedCompetition(tx, institution.id, {
        contact: { kind: "whatsapp", value: "6281234567890" },
      });

      const answer = await putContact(tx, member.id, competition.id, {
        kind: "phone",
        value: "0811-2222-3333",
      });

      expect(answer.status).toBe(403);
      expect(errorCodeOf(answer)).toBe("forbidden");
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "whatsapp",
        value: "6281234567890",
      });
    });
  });

  it("refuses an owner of another institution and leaves the contact as it was", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id, {
        contact: { kind: "whatsapp", value: "6281234567890" },
      });
      const otherInstitution = await seedInstitution(tx);
      const otherOwner = await seedUser(tx);
      await addMember(tx, otherInstitution.id, otherOwner.id, "institution_owner");

      const answer = await putContact(tx, otherOwner.id, competition.id, {
        kind: "phone",
        value: "0811-2222-3333",
      });

      expect(answer.status).toBe(403);
      expect(errorCodeOf(answer)).toBe("forbidden");
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "whatsapp",
        value: "6281234567890",
      });
    });
  });

  it("refuses a contact save sent for another account after a session change", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const otherUser = await seedUser(tx);
      const competition = await seedCompetition(tx, institution.id, {
        contact: { kind: "whatsapp", value: "6281234567890" },
      });

      const answer = await putContact(
        tx,
        owner.id,
        competition.id,
        { kind: "phone", value: "0811-2222-3333" },
        otherUser.id,
      );

      expect(answer.status).toBe(409);
      expect(errorCodeOf(answer)).toBe("session_user_mismatch");
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "whatsapp",
        value: "6281234567890",
      });
    });
  });

  it("does not show a draft's contact to a plain member or another institution's owner", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const member = await seedUser(tx);
      await addMember(tx, institution.id, member.id, "institution_member");
      const competition = await seedCompetition(tx, institution.id, {
        contact: { kind: "whatsapp", value: "6281234567890" },
      });
      const otherInstitution = await seedInstitution(tx);
      const otherOwner = await seedUser(tx);
      await addMember(tx, otherInstitution.id, otherOwner.id, "institution_owner");

      for (const reader of [member, otherOwner]) {
        const answer = await getContact(tx, reader.id, competition.id);
        expect(answer.status).toBe(403);
        expect(JSON.stringify(answer.body)).not.toContain("6281234567890");
      }
    });
  });

  it("refuses to clear a contact once set and leaves it as it was", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id, {
        contact: { kind: "whatsapp", value: "6281234567890" },
      });

      for (const payload of [
        { kind: "whatsapp", value: "" },
        { kind: null, value: null },
      ]) {
        const answer = await putContact(tx, owner.id, competition.id, payload);
        expect(answer.status).toBe(400);
        expect(errorCodeOf(answer)).toBe("competition_organizer_contact_invalid");
      }
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "whatsapp",
        value: "6281234567890",
      });
    });
  });

  it("refuses a WhatsApp number outside Indonesia and takes it as Telepon", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id);

      const refused = await putContact(tx, owner.id, competition.id, {
        kind: "whatsapp",
        value: "+1 555 123 4567",
      });
      expect(refused.status).toBe(400);
      expect(errorCodeOf(refused)).toBe("competition_organizer_contact_not_indonesian");
      expect(await readContact(tx, competition.id)).toEqual({ kind: null, value: null });

      const accepted = await putContact(tx, owner.id, competition.id, {
        kind: "phone",
        value: "+1 555 123 4567",
      });
      expect(accepted.status).toBe(200);
      expect(await readContact(tx, competition.id)).toEqual({
        kind: "phone",
        value: "15551234567",
      });
    });
  });

  it("fills a draft's suggestion from the owner's own newest approved sign-up and own email", async () => {
    await inRollback(async (tx) => {
      const now = Date.now();
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const secondOwner = await seedUser(tx);
      await addMember(tx, institution.id, secondOwner.id, "institution_owner");
      await seedSignup(tx, owner.id, "0811-0000-0001", "approved", new Date(now - 30 * DAY));
      await seedSignup(tx, owner.id, "0811-0000-0002", "approved", new Date(now - 10 * DAY));
      await seedSignup(tx, owner.id, "0811-0000-0003", "rejected", new Date(now - 1 * DAY));
      await seedSignup(tx, secondOwner.id, "0811-0000-0009", "approved", new Date(now));
      const competition = await seedCompetition(tx, institution.id);

      const answer = await getContact(tx, owner.id, competition.id);

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        contact: null,
        isDraft: true,
        suggestion: { mobileNumber: "0811-0000-0002", email: owner.email },
      });
    });
  });

  it("offers no suggestion to a staff member or on a published competition", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const staff = await seedUser(tx);
      await addMember(tx, institution.id, staff.id, "institution_staff");
      await seedSignup(tx, owner.id, "0811-0000-0001", "approved", new Date());
      await seedSignup(tx, staff.id, "0811-0000-0002", "approved", new Date());
      const draft = await seedCompetition(tx, institution.id);
      const live = await seedCompetition(tx, institution.id, { status: "published" });

      const staffAnswer = await getContact(tx, staff.id, draft.id);
      expect(staffAnswer.status).toBe(200);
      expect(staffAnswer.body).toEqual({ contact: null, isDraft: true, suggestion: null });

      const liveAnswer = await getContact(tx, owner.id, live.id);
      expect(liveAnswer.status).toBe(200);
      expect(liveAnswer.body).toEqual({ contact: null, isDraft: false, suggestion: null });
    });
  });

  it("suggests no number when the owner has no approved sign-up", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      await seedSignup(tx, owner.id, "0811-0000-0001", "pending_review", new Date());
      const competition = await seedCompetition(tx, institution.id);

      const answer = await getContact(tx, owner.id, competition.id);

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        contact: null,
        isDraft: true,
        suggestion: { mobileNumber: null, email: owner.email },
      });
    });
  });

  it("changes a live competition's contact without a notice to registrants", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx);
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id, {
        status: "published",
        contact: { kind: "whatsapp", value: "6281234567890" },
      });
      const candidate = await seedUser(tx, { role: "candidate" });
      await tx.insert(competitionRegistrations).values({
        competitionId: competition.id,
        studentId: candidate.id,
        registrationType: "individual",
        status: "confirmed",
      });

      const answer = await putContact(tx, owner.id, competition.id, {
        kind: "email",
        value: "panitia@example.test",
      });

      expect(answer.status).toBe(200);
      expect(queueMocks.enqueueCompetitionEdited).not.toHaveBeenCalled();
      const notices = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.userId, candidate.id));
      expect(notices).toEqual([]);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("publishing with a contact", () => {
  it("publishes through the real route once the contact is set, and the public page carries it", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const owner = await seedUser(tx, { tier: "elevated" });
      await addMember(tx, institution.id, owner.id, "institution_owner");
      const competition = await seedCompetition(tx, institution.id);

      const refused = await publish(tx, owner.id, institution, competition);
      expect(refused.status).toBe(422);
      expect(errorCodeOf(refused)).toBe("competition_organizer_contact_missing");
      expect(await readStatus(tx, competition.id)).toBe("draft");

      const saved = await putContact(tx, owner.id, competition.id, {
        kind: "whatsapp",
        value: "0812 3456 7890",
      });
      expect(saved.status).toBe(200);

      const published = await publish(tx, owner.id, institution, competition);
      expect(published.status).toBe(200);
      expect(await readStatus(tx, competition.id)).toBe("published");

      const detail = await getPublicCompetitionDetail(
        institution.slug,
        competition.slug,
        tx as unknown as Database,
      );
      expect(detail?.organizerContact).toEqual({ kind: "whatsapp", value: "6281234567890" });
    });
  });
});
