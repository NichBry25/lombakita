// @vitest-environment node
//
// A person who holds a live place in a competition of an institution cannot become that
// institution's owner or staff, and nobody rules on a transfer proof for their own place.
//
// Two shapes in one file. The rollback-wrapped suites seed through the real production paths
// (createIndividualRegistration, submitTeamRegistration, submitManualPaymentProof) and call the
// writers under test, so a refusal is proven against rows the product itself wrote. The race suite
// COMMITS, because one connection cannot block on itself and a second connection cannot see
// uncommitted rows. Everything it writes is found through MARKER and deleted again.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePayments,
  institutionInvitations,
  institutionMemberships,
  institutionPaymentInstructions,
  institutions,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { changeMemberRole } from "@/server/institution-members/member-service";
import { MemberError } from "@/server/institution-members/member-core";
import { acceptInstitutionInvitationForUser } from "@/server/institution-invitations/invitation-service";
import {
  hashToken,
  InstitutionInvitationError,
} from "@/server/institution-invitations/invitation-core";
import { createIndividualRegistration } from "@/server/registrations/registration-service";
import { RegistrationError } from "@/server/registrations/registration-core";
import { submitTeamRegistration } from "@/server/teams/team-registration-service";
import {
  ManualProofError,
  rejectManualPaymentProof,
  reopenManualPaymentProof,
  submitManualPaymentProof,
  verifyManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueuePaymentProofSubmitted: vi.fn(),
  enqueuePaymentOutcome: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  ...enqueueSpies,
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));

beforeEach(() => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

const MARKER = "hostref";
const DAY_MS = 86_400_000;

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);

type Refusal = { code: string; status: number };

const refusalOf = async (work: Promise<unknown>): Promise<Refusal | null> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof MemberError || error instanceof InstitutionInvitationError) {
      return { code: error.code, status: error.httpStatus };
    }
    if (error instanceof ManualProofError || error instanceof RegistrationError) {
      return { code: error.code, status: error.status };
    }
    throw error;
  }
  return null;
};

const HOLDS_PLACE: Refusal = { code: "member_holds_competition_place", status: 409 };

// ---------------------------------------------------------------------------------------------
// Seeds. Everything a place is made of is written by the product's own services.

const seedUser = async (
  tx: Tx,
  label: string,
  options: { recruiter: boolean } = { recruiter: false },
): Promise<string> => {
  const suffix = uniqueSuffix();
  const recruiterColumns = options.recruiter
    ? { recruiterVerifiedAt: new Date(), recruiterVerificationTier: "minimal" as const }
    : {};
  const [row] = await tx
    .insert(users)
    .values({
      email: `${MARKER}-${label}-${suffix}@example.test`,
      username: `${MARKER}_${label}_${suffix}`,
      candidateVerifiedAt: new Date(),
      ...recruiterColumns,
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedCompetition = async (
  tx: Tx,
  institutionId: string,
  options: { paid: boolean },
): Promise<string> => {
  const priceColumns = options.paid
    ? { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 }
    : {};
  const [row] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `${MARKER}-c-${uniqueSuffix()}`,
      title: "Lomba uji",
      status: "published",
      mode: "both",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: daysFromNow(-1),
      registrationEndAt: daysFromNow(30),
      eventStartAt: daysFromNow(60),
      eventEndAt: daysFromNow(61),
      allowCancellation: true,
      cancellationCutoffDays: 1,
      ...priceColumns,
    })
    .returning({ id: competitions.id });
  return row!.id;
};

type World = { institutionId: string; slug: string; ownerId: string; competitionId: string };

const seedWorld = async (tx: Tx, options: { paid: boolean } = { paid: false }): Promise<World> => {
  const suffix = uniqueSuffix();
  const ownerId = await seedUser(tx, "own", { recruiter: true });
  const slug = `${MARKER}-${suffix}`;

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug,
      institutionType: "company",
      displayName: `Host refusal ${suffix}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });
  const institutionId = institution!.id;

  await tx.insert(institutionMemberships).values({
    institutionId,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });

  if (options.paid) {
    await tx.insert(institutionPaymentInstructions).values({
      institutionId,
      bankName: "Bank Contoh",
      accountNumber: "1234567890",
      accountHolderName: "Panitia Lomba",
    });
    await tx.insert(financeFeeRules).values({
      institutionId,
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
    });
  }

  const competitionId = await seedCompetition(tx, institutionId, options);
  return { institutionId, slug, ownerId, competitionId };
};

const seedInstitutionMembership = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
): Promise<string> => {
  const [row] = await tx
    .insert(institutionMemberships)
    .values({ institutionId, userId, membershipRole, status: "active" })
    .returning({ id: institutionMemberships.id });
  return row!.id;
};

// A plain member of the institution who could be promoted: recruiter verified, so the verification
// refusal does not decide the outcome.
const seedPromotableMember = async (
  tx: Tx,
  world: World,
  label: string,
): Promise<{ userId: string; membershipId: string }> => {
  const userId = await seedUser(tx, label, { recruiter: true });
  const membershipId = await seedInstitutionMembership(
    tx,
    world.institutionId,
    userId,
    "institution_member",
  );
  return { userId, membershipId };
};

const seedFormingTeam = async (
  tx: Tx,
  competitionId: string,
  captainId: string,
  memberId: string,
): Promise<string> => {
  const [team] = await tx
    .insert(teams)
    .values({
      competitionId,
      captainId,
      name: `Tim ${uniqueSuffix()}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captainId, role: "captain", status: "active" },
    { teamId: team!.id, userId: memberId, role: "member", status: "active" },
  ]);

  return team!.id;
};

const registerIndividually = async (
  tx: Tx,
  userId: string,
  competitionId: string,
): Promise<string> => {
  const registration = await createIndividualRegistration(userId, competitionId, tx as never);
  return registration.id;
};

const registerTeamThroughService = async (
  tx: Tx,
  competitionId: string,
  captainId: string,
  teamId: string,
) => submitTeamRegistration(captainId, competitionId, teamId, tx as never);

const seedInvitation = async (
  tx: Tx,
  world: World,
  targetUserId: string,
  invitedRole: "institution_owner" | "institution_staff" | "institution_member",
  options: { expiresAt: Date } = { expiresAt: daysFromNow(7) },
): Promise<string> => {
  const [row] = await tx
    .insert(institutionInvitations)
    .values({
      institutionId: world.institutionId,
      invitedEmail: `${MARKER}-invitee-${uniqueSuffix()}@example.test`,
      invitedRole,
      tokenHash: hashToken(randomUUID()),
      status: "pending",
      invitedByUserId: world.ownerId,
      targetUserId,
      expiresAt: options.expiresAt,
    })
    .returning({ id: institutionInvitations.id });
  return row!.id;
};

// ---------------------------------------------------------------------------------------------
// What changes the answer of a live place.

const endTheEvent = async (tx: Tx, competitionId: string): Promise<void> => {
  await tx
    .update(competitions)
    .set({
      registrationStartAt: daysFromNow(-10),
      registrationEndAt: daysFromNow(-5),
      eventStartAt: daysFromNow(-3),
      eventEndAt: daysFromNow(-1),
    })
    .where(eq(competitions.id, competitionId));
};

const clearTheEventEnd = async (tx: Tx, competitionId: string): Promise<void> => {
  await tx.update(competitions).set({ eventEndAt: null }).where(eq(competitions.id, competitionId));
};

const softDeleteCompetition = async (tx: Tx, competitionId: string): Promise<void> => {
  await tx
    .update(competitions)
    .set({ deletedAt: new Date() })
    .where(eq(competitions.id, competitionId));
};

const cancelRegistrationsOf = async (tx: Tx, userId: string): Promise<void> => {
  await tx
    .update(competitionRegistrations)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "uji" })
    .where(eq(competitionRegistrations.studentId, userId));
};

const cancelRegistrationsOfTeam = async (tx: Tx, teamId: string): Promise<void> => {
  await tx
    .update(competitionRegistrations)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "uji" })
    .where(eq(competitionRegistrations.teamId, teamId));
};

const roleOf = async (tx: Tx, membershipId: string): Promise<string> => {
  const [row] = await tx
    .select({ role: institutionMemberships.membershipRole })
    .from(institutionMemberships)
    .where(eq(institutionMemberships.id, membershipId));
  return row!.role;
};

const registrationStatusesOf = async (tx: Tx, userId: string): Promise<string[]> => {
  const rows = await tx
    .select({ status: competitionRegistrations.status })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.studentId, userId));
  return rows.map((row) => row.status);
};

const promote = (
  tx: Tx,
  world: World,
  membershipId: string,
  role: "institution_owner" | "institution_staff" | "institution_member",
) => changeMemberRole(world.ownerId, world.slug, membershipId, role, tx as never);

const accept = (
  tx: Tx,
  invitationId: string,
  userId: string,
  verifiedRoles: ("candidate" | "recruiter")[] = ["recruiter"],
) => acceptInstitutionInvitationForUser(invitationId, userId, verifiedRoles, tx as never);

const invitationStatusOf = async (tx: Tx, invitationId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: institutionInvitations.status })
    .from(institutionInvitations)
    .where(eq(institutionInvitations.id, invitationId));
  return row!.status;
};

const activeMembershipRoleOf = async (
  tx: Tx,
  institutionId: string,
  userId: string,
): Promise<string | null> => {
  const [row] = await tx
    .select({ role: institutionMemberships.membershipRole })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.status, "active"),
      ),
    );
  return row?.role ?? null;
};

const ADMIN_ROLES_UNDER_TEST = ["institution_staff", "institution_owner"] as const;

// ---------------------------------------------------------------------------------------------
// The owner's promotion.

describe.skipIf(skipWithoutDatabase)("changeMemberRole and a live place (real database)", () => {
  it.each(ADMIN_ROLES_UNDER_TEST)(
    "refuses to make a member %s while they hold their own registration, and keeps it",
    async (role) => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const member = await seedPromotableMember(tx, world, "reg");
        await registerIndividually(tx, member.userId, world.competitionId);

        const refusal = await refusalOf(promote(tx, world, member.membershipId, role));

        expect({
          refusal,
          role: await roleOf(tx, member.membershipId),
          registrations: await registrationStatusesOf(tx, member.userId),
        }).toEqual({
          refusal: HOLDS_PLACE,
          role: "institution_member",
          registrations: ["confirmed"],
        });

        // The same person, once the event has ended: the refusal is about the place.
        await endTheEvent(tx, world.competitionId);
        await promote(tx, world, member.membershipId, role);
        expect(await roleOf(tx, member.membershipId)).toBe(role);
      });
    },
  );

  it("refuses a member of a registered team, whose place the team registration wrote", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const captainId = await seedUser(tx, "cap");
      const member = await seedPromotableMember(tx, world, "tm");
      const teamId = await seedFormingTeam(tx, world.competitionId, captainId, member.userId);
      await registerTeamThroughService(tx, world.competitionId, captainId, teamId);

      const refusal = await refusalOf(promote(tx, world, member.membershipId, "institution_staff"));

      expect(refusal).toEqual(HOLDS_PLACE);
      expect(await roleOf(tx, member.membershipId)).toBe("institution_member");
    });
  });

  it("refuses a teammate who has no registration row of their own", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const captainId = await seedUser(tx, "cap");
      const memberId = await seedUser(tx, "tm");
      const teamId = await seedFormingTeam(tx, world.competitionId, captainId, memberId);
      await registerTeamThroughService(tx, world.competitionId, captainId, teamId);

      // Seeded directly: the real team registration writes one row for each member it read, so
      // the teammate who joined a submitted team while it registered is not reachable through it.
      const orphan = await seedPromotableMember(tx, world, "orph");
      await tx
        .insert(teamMemberships)
        .values({ teamId, userId: orphan.userId, role: "member", status: "active" });
      expect(await registrationStatusesOf(tx, orphan.userId)).toEqual([]);

      const refusal = await refusalOf(promote(tx, world, orphan.membershipId, "institution_staff"));

      expect(refusal).toEqual(HOLDS_PLACE);
      expect(await roleOf(tx, orphan.membershipId)).toBe("institution_member");
    });
  });

  it("promotes a teammate with no registration row once the team's registrations are cancelled", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const captainId = await seedUser(tx, "cap");
      const memberId = await seedUser(tx, "tm");
      const teamId = await seedFormingTeam(tx, world.competitionId, captainId, memberId);
      await registerTeamThroughService(tx, world.competitionId, captainId, teamId);
      const orphan = await seedPromotableMember(tx, world, "orph");
      await tx
        .insert(teamMemberships)
        .values({ teamId, userId: orphan.userId, role: "member", status: "active" });
      await cancelRegistrationsOfTeam(tx, teamId);

      await promote(tx, world, orphan.membershipId, "institution_staff");

      expect(await roleOf(tx, orphan.membershipId)).toBe("institution_staff");
    });
  });

  it("promotes a member of a team that has not registered, which holds no place", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const captainId = await seedUser(tx, "cap");
      const member = await seedPromotableMember(tx, world, "tm");
      await seedFormingTeam(tx, world.competitionId, captainId, member.userId);

      await promote(tx, world, member.membershipId, "institution_staff");

      expect(await roleOf(tx, member.membershipId)).toBe("institution_staff");
    });
  });

  it("still refuses when the competition has no event end set", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const member = await seedPromotableMember(tx, world, "open");
      await registerIndividually(tx, member.userId, world.competitionId);
      await clearTheEventEnd(tx, world.competitionId);

      const refusal = await refusalOf(promote(tx, world, member.membershipId, "institution_staff"));

      expect(refusal).toEqual(HOLDS_PLACE);
    });
  });

  it.each([
    ["the event has ended", endTheEvent],
    ["the competition is deleted", softDeleteCompetition],
  ])("promotes a registered member when %s", async (_label, changeCompetition) => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const member = await seedPromotableMember(tx, world, "rel");
      await registerIndividually(tx, member.userId, world.competitionId);
      await changeCompetition(tx, world.competitionId);

      await promote(tx, world, member.membershipId, "institution_staff");

      expect(await roleOf(tx, member.membershipId)).toBe("institution_staff");
    });
  });

  it("promotes a member whose registration is cancelled", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const member = await seedPromotableMember(tx, world, "canc");
      await registerIndividually(tx, member.userId, world.competitionId);
      await cancelRegistrationsOf(tx, member.userId);

      await promote(tx, world, member.membershipId, "institution_staff");

      expect(await roleOf(tx, member.membershipId)).toBe("institution_staff");
    });
  });

  it("promotes a member who is registered in another institution's competition", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const otherWorld = await seedWorld(tx);
      const member = await seedPromotableMember(tx, world, "oth");
      await registerIndividually(tx, member.userId, otherWorld.competitionId);

      await promote(tx, world, member.membershipId, "institution_staff");

      expect(await roleOf(tx, member.membershipId)).toBe("institution_staff");
    });
  });

  it("keeps the verification refusal ahead of the place refusal", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const unverifiedId = await seedUser(tx, "unv");
      const membershipId = await seedInstitutionMembership(
        tx,
        world.institutionId,
        unverifiedId,
        "institution_member",
      );
      await registerIndividually(tx, unverifiedId, world.competitionId);

      const refusal = await refusalOf(promote(tx, world, membershipId, "institution_staff"));

      expect(refusal).toEqual({ code: "role_escalation_forbidden", status: 403 });
    });
  });

  it("changes nothing for people who already hold the role: owner and staff moves, demotions", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const dual = await seedPromotableMember(tx, world, "dual");
      await registerIndividually(tx, dual.userId, world.competitionId);
      // The state this step does not repair: registered first, made staff by some other path.
      await tx
        .update(institutionMemberships)
        .set({ membershipRole: "institution_staff" })
        .where(eq(institutionMemberships.id, dual.membershipId));

      await promote(tx, world, dual.membershipId, "institution_owner");
      expect(await roleOf(tx, dual.membershipId)).toBe("institution_owner");

      await promote(tx, world, dual.membershipId, "institution_staff");
      expect(await roleOf(tx, dual.membershipId)).toBe("institution_staff");

      await promote(tx, world, dual.membershipId, "institution_member");
      expect(await roleOf(tx, dual.membershipId)).toBe("institution_member");
    });
  });

  it("does not refuse the registration of a member: joining stays open to everyone", async () => {
    await inRollback(async (tx) => {
      const world = await seedWorld(tx);
      const member = await seedPromotableMember(tx, world, "join");

      const registrationId = await registerIndividually(tx, member.userId, world.competitionId);

      expect(registrationId).toEqual(expect.any(String));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The invitation accept.

describe.skipIf(skipWithoutDatabase)(
  "acceptInstitutionInvitationForUser and a live place (real database)",
  () => {
    it.each(ADMIN_ROLES_UNDER_TEST)(
      "refuses a %s invitation while the person holds their own registration, and leaves it pending",
      async (role) => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const inviteeId = await seedUser(tx, "inv", { recruiter: true });
          await registerIndividually(tx, inviteeId, world.competitionId);
          const invitationId = await seedInvitation(tx, world, inviteeId, role);

          const refusal = await refusalOf(accept(tx, invitationId, inviteeId));

          expect({
            refusal,
            invitation: await invitationStatusOf(tx, invitationId),
            membership: await activeMembershipRoleOf(tx, world.institutionId, inviteeId),
          }).toEqual({ refusal: HOLDS_PLACE, invitation: "pending", membership: null });

          // The same invitation, once the event has ended: the refusal is about the place.
          await endTheEvent(tx, world.competitionId);
          await accept(tx, invitationId, inviteeId);

          expect({
            invitation: await invitationStatusOf(tx, invitationId),
            membership: await activeMembershipRoleOf(tx, world.institutionId, inviteeId),
          }).toEqual({ invitation: "accepted", membership: role });
        });
      },
    );

    it("refuses a staff invitation to a member of a registered team", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const captainId = await seedUser(tx, "cap");
        const inviteeId = await seedUser(tx, "tm", { recruiter: true });
        const teamId = await seedFormingTeam(tx, world.competitionId, captainId, inviteeId);
        await registerTeamThroughService(tx, world.competitionId, captainId, teamId);
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");

        const refusal = await refusalOf(accept(tx, invitationId, inviteeId));

        expect(refusal).toEqual(HOLDS_PLACE);
        expect(await invitationStatusOf(tx, invitationId)).toBe("pending");
      });
    });

    it("refuses a staff invitation to a teammate who has no registration row of their own", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const captainId = await seedUser(tx, "cap");
        const memberId = await seedUser(tx, "tm");
        const teamId = await seedFormingTeam(tx, world.competitionId, captainId, memberId);
        await registerTeamThroughService(tx, world.competitionId, captainId, teamId);
        const inviteeId = await seedUser(tx, "orph", { recruiter: true });
        await tx
          .insert(teamMemberships)
          .values({ teamId, userId: inviteeId, role: "member", status: "active" });
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");

        const refusal = await refusalOf(accept(tx, invitationId, inviteeId));

        expect(refusal).toEqual(HOLDS_PLACE);
        expect(await invitationStatusOf(tx, invitationId)).toBe("pending");
      });
    });

    it("accepts a member invitation for a registered person", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const inviteeId = await seedUser(tx, "inv");
        await registerIndividually(tx, inviteeId, world.competitionId);
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_member");

        await accept(tx, invitationId, inviteeId, ["candidate"]);

        expect(await activeMembershipRoleOf(tx, world.institutionId, inviteeId)).toBe(
          "institution_member",
        );
      });
    });

    it.each([
      ["the event has ended", endTheEvent],
      ["the competition is deleted", softDeleteCompetition],
    ])("accepts a staff invitation when %s", async (_label, changeCompetition) => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const inviteeId = await seedUser(tx, "inv", { recruiter: true });
        await registerIndividually(tx, inviteeId, world.competitionId);
        await changeCompetition(tx, world.competitionId);
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");

        await accept(tx, invitationId, inviteeId);

        expect(await activeMembershipRoleOf(tx, world.institutionId, inviteeId)).toBe(
          "institution_staff",
        );
      });
    });

    it("accepts a staff invitation when the registration is cancelled", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const inviteeId = await seedUser(tx, "inv", { recruiter: true });
        await registerIndividually(tx, inviteeId, world.competitionId);
        await cancelRegistrationsOf(tx, inviteeId);
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");

        await accept(tx, invitationId, inviteeId);

        expect(await invitationStatusOf(tx, invitationId)).toBe("accepted");
      });
    });

    it("accepts a staff invitation for a person registered in another institution's competition", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const otherWorld = await seedWorld(tx);
        const inviteeId = await seedUser(tx, "inv", { recruiter: true });
        await registerIndividually(tx, inviteeId, otherWorld.competitionId);
        const invitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");

        await accept(tx, invitationId, inviteeId);

        expect(await invitationStatusOf(tx, invitationId)).toBe("accepted");
      });
    });

    // Each refusal the accept made before this step still wins over the place refusal, which is
    // what puts the place check after all of them.
    it("keeps the invitation refusals ahead of the place refusal", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const inviteeId = await seedUser(tx, "inv", { recruiter: true });
        await registerIndividually(tx, inviteeId, world.competitionId);
        const staffInvitationId = await seedInvitation(tx, world, inviteeId, "institution_staff");
        const expiredInvitationId = await seedInvitation(
          tx,
          world,
          inviteeId,
          "institution_staff",
          { expiresAt: daysFromNow(-1) },
        );
        const otherUserId = await seedUser(tx, "oth", { recruiter: true });
        const othersInvitationId = await seedInvitation(
          tx,
          world,
          otherUserId,
          "institution_staff",
        );

        const results = {
          notAddressedToCaller: await refusalOf(accept(tx, othersInvitationId, inviteeId)),
          expired: await refusalOf(accept(tx, expiredInvitationId, inviteeId)),
          notRecruiterVerified: await refusalOf(
            accept(tx, staffInvitationId, inviteeId, ["candidate"]),
          ),
        };

        expect(results).toEqual({
          notAddressedToCaller: { code: "invitation_not_found", status: 404 },
          expired: { code: "invitation_not_actionable", status: 410 },
          notRecruiterVerified: { code: "invitation_role_verification_required", status: 403 },
        });
      });
    });

    it("keeps the already-a-member refusal ahead of the place refusal", async () => {
      await inRollback(async (tx) => {
        const world = await seedWorld(tx);
        const member = await seedPromotableMember(tx, world, "mem");
        await registerIndividually(tx, member.userId, world.competitionId);
        const invitationId = await seedInvitation(tx, world, member.userId, "institution_staff");

        const refusal = await refusalOf(accept(tx, invitationId, member.userId));

        expect(refusal).toEqual({ code: "invitation_already_member", status: 409 });
      });
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The verdict on a transfer proof.

type PaidWorld = World & { payerId: string; captainId: string; memberId: string; teamId: string };

const seedPaidWorld = async (tx: Tx): Promise<PaidWorld> => {
  const world = await seedWorld(tx, { paid: true });
  const payerId = await seedUser(tx, "payer");
  const captainId = await seedUser(tx, "cap");
  const memberId = await seedUser(tx, "tm");
  const teamId = await seedFormingTeam(tx, world.competitionId, captainId, memberId);
  return { ...world, payerId, captainId, memberId, teamId };
};

const paymentIdAnchoredOn = async (tx: Tx, registrationId: string): Promise<string> => {
  const [payment] = await tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.competitionRegistrationId, registrationId));
  return payment!.id;
};

const sendProof = async (
  tx: Tx,
  paymentId: string,
  payerUserId: string,
  competitionId: string,
): Promise<string> => {
  const proof = await submitManualPaymentProof(
    {
      paymentId,
      submittedByUserId: payerUserId,
      r2Key: `payment-proofs/${competitionId}/${paymentId}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return proof.id;
};

const payerProofThroughRealPaths = async (tx: Tx, world: PaidWorld): Promise<string> => {
  const registrationId = await registerIndividually(tx, world.payerId, world.competitionId);
  const paymentId = await paymentIdAnchoredOn(tx, registrationId);
  return sendProof(tx, paymentId, world.payerId, world.competitionId);
};

const teamProofThroughRealPaths = async (tx: Tx, world: PaidWorld): Promise<string> => {
  const result = await registerTeamThroughService(
    tx,
    world.competitionId,
    world.captainId,
    world.teamId,
  );
  const captainRow = result.registrations.find((row) => row.studentId === world.captainId);
  const paymentId = await paymentIdAnchoredOn(tx, captainRow!.id);
  return sendProof(tx, paymentId, world.captainId, world.competitionId);
};

const proofStatusOf = async (tx: Tx, proofId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: financeManualPaymentProofs.status })
    .from(financeManualPaymentProofs)
    .where(eq(financeManualPaymentProofs.id, proofId));
  return row!.status;
};

const paymentIdOfProof = async (tx: Tx, proofId: string): Promise<string> => {
  const [proof] = await tx
    .select({ paymentId: financeManualPaymentProofs.paymentId })
    .from(financeManualPaymentProofs)
    .where(eq(financeManualPaymentProofs.id, proofId));
  return proof!.paymentId;
};

const succeededEventCountOf = async (tx: Tx, proofId: string): Promise<number> => {
  const paymentId = await paymentIdOfProof(tx, proofId);
  const events = await tx
    .select({ eventType: financePaymentEvents.eventType })
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, paymentId));
  return events.filter((event) => event.eventType === "succeeded").length;
};

const verify = (tx: Tx, institutionId: string, reviewerId: string, proofId: string) =>
  verifyManualPaymentProof(institutionId, reviewerId, proofId, tx as never);

const reject = (tx: Tx, institutionId: string, reviewerId: string, proofId: string) =>
  rejectManualPaymentProof(
    institutionId,
    reviewerId,
    proofId,
    "nominal tidak sesuai",
    true,
    tx as never,
  );

const OWN_PLACE: Refusal = { code: "payment_proof_own_place", status: 403 };

describe.skipIf(skipWithoutDatabase)("the verdict on a transfer proof (real database)", () => {
  it("refuses the payer, who is also staff, on verify and on reject, and leaves the proof pending", async () => {
    await inRollback(async (tx) => {
      const world = await seedPaidWorld(tx);
      const proofId = await payerProofThroughRealPaths(tx, world);
      await seedInstitutionMembership(tx, world.institutionId, world.payerId, "institution_staff");

      const verifyRefusal = await refusalOf(
        verify(tx, world.institutionId, world.payerId, proofId),
      );
      const rejectRefusal = await refusalOf(
        reject(tx, world.institutionId, world.payerId, proofId),
      );

      expect({
        verifyRefusal,
        rejectRefusal,
        status: await proofStatusOf(tx, proofId),
        succeeded: await succeededEventCountOf(tx, proofId),
      }).toEqual({
        verifyRefusal: OWN_PLACE,
        rejectRefusal: OWN_PLACE,
        status: "pending_review",
        succeeded: 0,
      });
    });
  });

  it("lets another staff member verify the same proof", async () => {
    await inRollback(async (tx) => {
      const world = await seedPaidWorld(tx);
      const proofId = await payerProofThroughRealPaths(tx, world);
      await seedInstitutionMembership(tx, world.institutionId, world.payerId, "institution_staff");

      await verify(tx, world.institutionId, world.ownerId, proofId);

      expect({
        status: await proofStatusOf(tx, proofId),
        succeeded: await succeededEventCountOf(tx, proofId),
      }).toEqual({ status: "verified", succeeded: 1 });
    });
  });

  it("lets another staff member reject it, and lets the payer who is staff resubmit", async () => {
    await inRollback(async (tx) => {
      const world = await seedPaidWorld(tx);
      const proofId = await payerProofThroughRealPaths(tx, world);
      await seedInstitutionMembership(tx, world.institutionId, world.payerId, "institution_staff");

      await reject(tx, world.institutionId, world.ownerId, proofId);
      expect(await proofStatusOf(tx, proofId)).toBe("rejected");

      const paymentId = await paymentIdOfProof(tx, proofId);
      await reopenManualPaymentProof(
        {
          proofId,
          submittedByUserId: world.payerId,
          r2Key: `payment-proofs/${world.competitionId}/${paymentId}/second.jpg`,
          originalFileName: "bukti2.jpg",
        },
        tx as never,
      );

      expect(await proofStatusOf(tx, proofId)).toBe("pending_review");
    });
  });

  it("refuses a teammate who is staff, and one with no registration row, on their team's proof", async () => {
    await inRollback(async (tx) => {
      const world = await seedPaidWorld(tx);
      const proofId = await teamProofThroughRealPaths(tx, world);
      await seedInstitutionMembership(tx, world.institutionId, world.memberId, "institution_staff");
      await seedInstitutionMembership(
        tx,
        world.institutionId,
        world.captainId,
        "institution_staff",
      );
      const orphanId = await seedUser(tx, "orph");
      await seedInstitutionMembership(tx, world.institutionId, orphanId, "institution_staff");
      await tx
        .insert(teamMemberships)
        .values({ teamId: world.teamId, userId: orphanId, role: "member", status: "active" });

      const refusals = {
        teammateVerify: await refusalOf(verify(tx, world.institutionId, world.memberId, proofId)),
        teammateReject: await refusalOf(reject(tx, world.institutionId, world.memberId, proofId)),
        captainVerify: await refusalOf(verify(tx, world.institutionId, world.captainId, proofId)),
        orphanVerify: await refusalOf(verify(tx, world.institutionId, orphanId, proofId)),
      };

      expect({
        refusals,
        status: await proofStatusOf(tx, proofId),
        succeeded: await succeededEventCountOf(tx, proofId),
      }).toEqual({
        refusals: {
          teammateVerify: OWN_PLACE,
          teammateReject: OWN_PLACE,
          captainVerify: OWN_PLACE,
          orphanVerify: OWN_PLACE,
        },
        status: "pending_review",
        succeeded: 0,
      });

      await verify(tx, world.institutionId, world.ownerId, proofId);
      expect(await proofStatusOf(tx, proofId)).toBe("verified");
    });
  });

  it("reads another organiser's proof as not found before it asks whose place it is", async () => {
    await inRollback(async (tx) => {
      const world = await seedPaidWorld(tx);
      const proofId = await payerProofThroughRealPaths(tx, world);
      const otherWorld = await seedWorld(tx);

      const refusals = {
        verify: await refusalOf(verify(tx, otherWorld.institutionId, world.payerId, proofId)),
        reject: await refusalOf(reject(tx, otherWorld.institutionId, world.payerId, proofId)),
      };

      expect(refusals).toEqual({
        verify: { code: "manual_proof_not_found", status: 404 },
        reject: { code: "manual_proof_not_found", status: 404 },
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The race. A join and a promotion of the same person, in both orders, each held at a fixed
// point by a third connection and confirmed parked through the database's own wait graph.

type Connection = {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (): Connection => {
  // One connection per participant, never recycled: the barrier depends on a racer's queries
  // landing on the backend whose pid was captured.
  const connectionClient = postgres(TEST_DATABASE_URL!, { max: 1, idle_timeout: 0 });
  return { sql: connectionClient, db: drizzle(connectionClient, { schema }) };
};

const BARRIER_TIMEOUT_MS = 10_000;
const BARRIER_POLL_MS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let control: Connection;
let barrier: Connection;
let joinRacer: Connection;
let promotionRacer: Connection;

const backendPidOf = async (connection: Connection): Promise<number> => {
  const rows = await connection.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return Number(rows[0]!.pid);
};

// Transitive: Postgres points the second waiter at the first waiter's lock, so a direct check reads
// a correctly formed queue as no queue.
const transitiveBlockersOf = async (waiterPid: number): Promise<number[]> => {
  const rows = await control.sql<{ pid: number }[]>`
    with recursive chain(pid) as (
      select unnest(pg_blocking_pids(${waiterPid}))
      union
      select unnest(pg_blocking_pids(chain.pid)) from chain
    )
    select pid from chain`;
  return rows.map((row) => Number(row.pid));
};

const blockersOnceParked = async (waiterPid: number, blockerPid: number): Promise<number[]> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const chain = await transitiveBlockersOf(waiterPid);
    if (chain.includes(blockerPid)) return chain;
    await sleep(BARRIER_POLL_MS);
  }

  return transitiveBlockersOf(waiterPid);
};

// The statement a parked backend is stopped on, read from the database rather than assumed.
const parkedStatementOf = async (pid: number): Promise<string> => {
  const rows = await control.sql<{ query: string | null }[]>`
    select query from pg_stat_activity where pid = ${pid}`;
  return rows[0]?.query ?? "";
};

const sweep = async (connection: Connection): Promise<void> => {
  await connection.sql.begin(async (tx) => {
    await tx.unsafe(
      `delete from competition_registrations
       where competition_id in (
         select id from competitions
         where institution_id in (select id from institutions where slug like $1))`,
      [`${MARKER}-%`],
    );
    await tx.unsafe(
      `delete from institution_memberships
       where institution_id in (select id from institutions where slug like $1)`,
      [`${MARKER}-%`],
    );
    await tx.unsafe(`delete from institutions where slug like $1`, [`${MARKER}-%`]);
    await tx.unsafe(`delete from users where username like $1`, [`${MARKER}%`]);
  });
};

const survivorsOf = async (
  connection: Connection,
): Promise<{ institutions: number; users: number }> => {
  const [institutionRows, userRows] = await Promise.all([
    connection.sql<{ n: number }[]>`
      select count(*)::int as n from institutions where slug like ${`${MARKER}-%`}`,
    connection.sql<{ n: number }[]>`
      select count(*)::int as n from users where username like ${`${MARKER}%`}`,
  ]);
  return { institutions: institutionRows[0]!.n, users: userRows[0]!.n };
};

const roleInDatabase = async (membershipId: string): Promise<string> => {
  const rows = await control.sql<{ role: string }[]>`
    select membership_role as role from institution_memberships where id = ${membershipId}`;
  return rows[0]!.role;
};

const liveRegistrationCountInDatabase = async (userId: string): Promise<number> => {
  const rows = await control.sql<{ n: number }[]>`
    select count(*)::int as n from competition_registrations
    where student_id = ${userId} and status <> 'cancelled'`;
  return rows[0]!.n;
};

describe.skipIf(skipWithoutDatabase)("a join and a promotion of the same person", () => {
  beforeAll(async () => {
    control = openConnection();
    barrier = openConnection();
    joinRacer = openConnection();
    promotionRacer = openConnection();

    await sweep(control);
  });

  afterAll(async () => {
    try {
      await sweep(control);
      expect(await survivorsOf(control), "rows this suite wrote survived its sweep").toEqual({
        institutions: 0,
        users: 0,
      });
    } finally {
      for (const connection of [promotionRacer, joinRacer, barrier, control]) {
        await connection?.sql.end({ timeout: 5 });
      }
    }
  });

  it("refuses the promotion when the join passed its host check first and is still writing", async () => {
    const committedTx = control.db as unknown as Tx;
    const world = await seedWorld(committedTx);
    const target = await seedPromotableMember(committedTx, world, "first");

    const barrierPid = await backendPidOf(barrier);
    const joinPid = await backendPidOf(joinRacer);
    const promotionPid = await backendPidOf(promotionRacer);

    let join: Promise<unknown> = Promise.resolve();
    let promotion: Promise<unknown> = Promise.resolve();
    let settled: PromiseSettledResult<unknown>[] = [];

    try {
      await barrier.sql.begin(async (barrierTx) => {
        // The join's insert references this row, so the join holds its participation lock, has read
        // that the person is not a host, and then waits here. That is the harmful moment.
        await barrierTx.unsafe(`select id from users where id = $1 for update`, [target.userId]);

        join = createIndividualRegistration(
          target.userId,
          world.competitionId,
          joinRacer.db as never,
        );
        join.catch(() => {});

        const joinChain = await blockersOnceParked(joinPid, barrierPid);
        expect(joinChain, "the join never reached its write").toContain(barrierPid);
        expect(await parkedStatementOf(joinPid)).toMatch(
          /insert into "competition_registrations"/i,
        );

        promotion = changeMemberRole(
          world.ownerId,
          world.slug,
          target.membershipId,
          "institution_staff",
          promotionRacer.db as never,
        );
        promotion.catch(() => {});

        const promotionChain = await blockersOnceParked(promotionPid, joinPid);
        expect(
          promotionChain,
          "the promotion did not queue behind the join: it is not taking the competition's " +
            "participation lock before it reads whether the person holds a place",
        ).toContain(joinPid);
        expect(await parkedStatementOf(promotionPid)).toMatch(/pg_advisory_xact_lock/i);
      });
    } finally {
      settled = await Promise.allSettled([join, promotion]);
    }

    expect(settled[0]!.status).toBe("fulfilled");
    expect(settled[1]!.status).toBe("rejected");

    const refusal = (settled[1] as PromiseRejectedResult).reason;
    expect(refusal).toBeInstanceOf(MemberError);
    expect((refusal as MemberError).code).toBe("member_holds_competition_place");

    expect(await roleInDatabase(target.membershipId)).toBe("institution_member");
    expect(await liveRegistrationCountInDatabase(target.userId)).toBe(1);
  }, 60_000);

  it("refuses the join as a host when the promotion committed first, and registers nothing", async () => {
    const committedTx = control.db as unknown as Tx;
    const world = await seedWorld(committedTx);
    const target = await seedPromotableMember(committedTx, world, "second");

    const barrierPid = await backendPidOf(barrier);
    const joinPid = await backendPidOf(joinRacer);
    const promotionPid = await backendPidOf(promotionRacer);

    let join: Promise<unknown> = Promise.resolve();
    let promotion: Promise<unknown> = Promise.resolve();
    let settled: PromiseSettledResult<unknown>[] = [];

    try {
      await barrier.sql.begin(async (barrierTx) => {
        // The promotion has taken its locks and read that the person holds no place, and waits at
        // its own write. The join arrives while it holds the competition's participation lock.
        await barrierTx.unsafe(`select id from institution_memberships where id = $1 for update`, [
          target.membershipId,
        ]);

        promotion = changeMemberRole(
          world.ownerId,
          world.slug,
          target.membershipId,
          "institution_staff",
          promotionRacer.db as never,
        );
        promotion.catch(() => {});

        const promotionChain = await blockersOnceParked(promotionPid, barrierPid);
        expect(promotionChain, "the promotion never reached its write").toContain(barrierPid);
        expect(await parkedStatementOf(promotionPid)).toMatch(/update "institution_memberships"/i);

        join = createIndividualRegistration(
          target.userId,
          world.competitionId,
          joinRacer.db as never,
        );
        join.catch(() => {});

        const joinChain = await blockersOnceParked(joinPid, promotionPid);
        expect(
          joinChain,
          "the join did not queue behind the promotion's participation lock",
        ).toContain(promotionPid);
        expect(await parkedStatementOf(joinPid)).toMatch(/pg_advisory_xact_lock/i);
      });
    } finally {
      settled = await Promise.allSettled([join, promotion]);
    }

    expect(settled[1]!.status).toBe("fulfilled");
    expect(settled[0]!.status).toBe("rejected");

    const refusal = (settled[0] as PromiseRejectedResult).reason;
    expect(refusal).toBeInstanceOf(RegistrationError);
    expect((refusal as RegistrationError).code).toBe("registration_host_of_competition");

    expect(await roleInDatabase(target.membershipId)).toBe("institution_staff");
    expect(await liveRegistrationCountInDatabase(target.userId)).toBe(0);
  }, 60_000);
});
