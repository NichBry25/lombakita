// @vitest-environment node
//
// The de-identification action against a real Postgres, with object storage mocked at the only three
// calls that reach the network.
//
// WHY THIS FILE COMMITS NOTHING. Every test runs inside a transaction that is ALWAYS rolled back, and
// the action under test is handed a shim whose `transaction` opens a SAVEPOINT on that same
// connection. So the service's own stages — pre-read, rehearsal, storage, commit — run for real, in
// real transactions, against real constraints, and the whole fixture still disappears at the end.
// The alternative shape, calling `deidentifyAccount` on the pool, would commit a de-identification of
// a real row into the developer's database on every run.
//
// WHAT A SAVEPOINT DOES NOT BUY, and where the concurrency proof therefore cannot live: two racers in
// one outer transaction share one connection, and one connection cannot block on itself. That claim
// needs two backends and is made in `account-deidentification-race-db.integration.test.ts`.
//
// THE REHEARSAL IS PROVEN BY A CONSTRAINT, not by reading the code. `alter table ... add constraint`
// a CHECK the scrub violates, run the action, and the commitment boundary is observable from outside:
// the action reports 500, storage was never reached, and every row is where it was. The constraint is
// dropped in a `finally` and its absence asserted, because a temporary DDL that outlives its test is
// a fixture that changes every later run (Rule 35).

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  TEST_DATABASE_URL,
  TEST_DDL_DATABASE_URL,
  skipWithoutDatabase,
} from "@/server/testing/database-url";
import {
  accounts,
  candidateProfiles,
  competitionDocumentRequestFiles,
  competitionDocumentRequests,
  competitionRegistrations,
  competitionResults,
  competitionReviews,
  competitionSaves,
  competitionSubmissions,
  competitions,
  institutionInvitations,
  institutionMemberships,
  institutionPaymentInstructions,
  institutionSocialLinks,
  institutionVerificationDocuments,
  institutionVerificationSubmissions,
  institutions,
  mfaFactors,
  mfaRecoveryCodes,
  notifications,
  platformOpsAuditLogs,
  platformOpsNotes,
  profileCertifications,
  profileSkills,
  recruiterVerificationDocuments,
  recruiterVerificationSubmissions,
  sessions,
  teamInvitations,
  teamMemberships,
  teams,
  userEmailVerificationTokens,
  userPasswordCredentials,
  userPlatformRoles,
  userProfiles,
  users,
  verificationTokens,
} from "@/server/db/schema";

/**
 * The storage seam. Only the three functions the action calls are replaced, and they answer from an
 * in-memory bucket rather than a fake verdict — so a prefix that reached further than it should is
 * visible as a key that left the bucket, not as a flag someone had to remember to check.
 */
const r2 = vi.hoisted(() => ({
  available: true,
  objects: [] as string[],
  listed: [] as string[],
  deleted: [] as string[],
  /** Refuse every list whose prefix starts with this, to drive the 502 ordering proof. */
  failFrom: null as string | null,
}));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => r2.available,
  listObjects: async (prefix: string) => {
    r2.listed.push(prefix);

    if (r2.failFrom !== null && prefix.startsWith(r2.failFrom)) {
      throw new Error("storage is down");
    }

    return r2.objects
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, lastModified: null }));
  },
  deleteObject: async (key: string) => {
    r2.deleted.push(key);

    const at = r2.objects.indexOf(key);
    if (at !== -1) r2.objects.splice(at, 1);
  },
}));

import { deidentifyAccount, DeidentificationError } from "./account-deidentification-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<NonNullable<typeof db>["transaction"]>[0]>[0];
type AccountDb = Parameters<typeof deidentifyAccount>[3];

/** The sentinel `inRollback` catches; anything else is a real failure and is rethrown. */
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

type Hooks = {
  /**
   * Run immediately before the Nth `transaction` call on the shim (1-based). The action makes exactly
   * three: the pre-read, the rehearsal and the commit.
   */
  beforeTransaction?: { nth: number; run: () => Promise<void> };
};

/**
 * The handle the action writes through.
 *
 * `deidentifyAccount` takes a `Database`, and every stage it runs opens a transaction on it. This
 * hands it the outer test transaction instead, so the action's own transactions are savepoints and
 * the fixture survives to be asserted on.
 */
const shimFor = (tx: Tx, hooks: Hooks = {}): AccountDb => {
  let calls = 0;

  return {
    transaction: async (fn: (nested: Tx) => Promise<unknown>) => {
      calls += 1;

      if (hooks.beforeTransaction?.nth === calls) {
        await hooks.beforeTransaction.run();
      }

      return tx.transaction(fn);
    },
  } as unknown as AccountDb;
};

const run = async (
  tx: Tx,
  actorUserId: string,
  accountId: string,
  input: { confirmUsername: string; reason: string },
  hooks?: Hooks,
) => deidentifyAccount(actorUserId, accountId, input, shimFor(tx, hooks));

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to refuse, but it resolved");
};

const expectCode = async (promise: Promise<unknown>, code: string, status: number) => {
  const error = await rejection(promise);

  expect(error, `expected a ${code} refusal`).toBeInstanceOf(DeidentificationError);
  expect((error as DeidentificationError).code).toBe(code);
  expect((error as DeidentificationError).status).toBe(status);

  return error as DeidentificationError;
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

// ---------------------------------------------------------------------------------------------
// The fixture.
//
// Every value is written through the schema objects rather than as raw SQL, so a column this file
// names wrongly is a type error here rather than a runtime failure in the middle of a suite that
// takes a minute to reach the line.

type Fixture = ReturnType<typeof identityOf>;

const identityOf = (suffix: string) => ({
  suffix,
  operator: randomUUID(),
  target: randomUUID(),
  bystander: randomUUID(),
  institution: randomUUID(),
  competition: randomUUID(),
  registration: randomUUID(),
  otherRegistration: randomUUID(),
  team: randomUUID(),
  request: randomUUID(),
  recruiterSubmission: randomUUID(),
  verificationSubmission: randomUUID(),
  payment: randomUUID(),
  targetEmail: `deident_target_${suffix}@example.test`,
  targetUsername: `deident_target_${suffix}`,
  targetName: `Rina Sasmita ${suffix}`,
});

const buildFixture = async (tx: Tx): Promise<Fixture> => {
  const f = identityOf(uniqueSuffix());

  await tx.insert(users).values([
    {
      id: f.operator,
      email: `deident_ops_${f.suffix}@example.test`,
      username: `deident_ops_${f.suffix}`,
      name: "Ops Fixture",
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    },
    {
      id: f.target,
      email: f.targetEmail,
      username: f.targetUsername,
      name: f.targetName,
      candidateVerifiedAt: new Date(),
    },
    {
      id: f.bystander,
      email: `deident_by_${f.suffix}@example.test`,
      username: `deident_by_${f.suffix}`,
      name: "Bystander Fixture",
      candidateVerifiedAt: new Date(),
    },
  ]);

  await tx.insert(userProfiles).values({
    userId: f.target,
    displayName: f.targetName,
    phoneNumber: "+628123456789",
    avatarR2Key: `avatars/${f.target}/a.jpg`,
    bannerR2Key: `banners/${f.target}/b.jpg`,
    summary: "Ringkasan pribadi",
    location: "Bandung",
    resumeR2Key: `resumes/${f.target}/cv.pdf`,
    resumeFileName: "cv-rina.pdf",
    resumeSizeBytes: 2048,
    resumeMimeType: "application/pdf",
    resumeUploadedAt: new Date(),
    resumePublic: true,
  });

  await tx.insert(candidateProfiles).values({
    userId: f.target,
    fullName: f.targetName,
    phoneNumber: "+628123456789",
    occupation: "college_student",
    dateOfBirth: "2004-03-11",
  });

  await tx.insert(institutions).values({
    id: f.institution,
    slug: `personal-${f.suffix}`,
    institutionType: "personal",
    displayName: `Rina ${f.suffix}`,
    status: "active",
    verificationStatus: "verified",
    description: "Institusi personal milik Rina",
    contactName: "Rina",
    contactEmail: f.targetEmail,
  });

  await tx.insert(institutionMemberships).values({
    id: randomUUID(),
    institutionId: f.institution,
    userId: f.target,
    membershipRole: "institution_owner",
    status: "active",
  });

  await tx.insert(institutionSocialLinks).values({
    id: randomUUID(),
    institutionId: f.institution,
    platform: "instagram",
    url: "https://instagram.com/rina",
  });

  await tx.insert(institutionPaymentInstructions).values({
    id: randomUUID(),
    institutionId: f.institution,
    qrisR2Key: `payment-instructions/${f.institution}/qris.png`,
  });

  await tx.insert(institutionVerificationSubmissions).values({
    id: f.verificationSubmission,
    institutionId: f.institution,
    submittedByUserId: f.target,
    targetInstitutionType: "personal",
    proposedDisplayName: `Rina ${f.suffix}`,
    status: "pending_review",
    reviewerNotes: "Berkas lengkap, disetujui peninjau.",
  });

  await tx.insert(institutionVerificationDocuments).values({
    id: randomUUID(),
    submissionId: f.verificationSubmission,
    documentType: "ktp",
    r2Key: `verification/${f.institution}/${f.verificationSubmission}/ktp.pdf`,
    originalFileName: "ktp-rina.pdf",
    fileSizeBytes: 1024,
    contentType: "application/pdf",
  });

  await tx.insert(competitions).values({
    id: f.competition,
    institutionId: f.institution,
    slug: `kuis-${f.suffix}`,
    title: `Kuis ${f.suffix}`,
    status: "draft",
    createdByUserId: f.target,
  });

  await tx.insert(competitionRegistrations).values([
    {
      id: f.registration,
      competitionId: f.competition,
      studentId: f.target,
      registrationType: "individual",
      status: "confirmed",
      internalNotes: "Catatan internal tentang Rina",
    },
    {
      id: f.otherRegistration,
      competitionId: f.competition,
      studentId: f.bystander,
      registrationType: "individual",
      status: "confirmed",
      internalNotes: "Catatan internal tentang bystander",
    },
  ]);

  await tx.insert(teams).values({
    id: f.team,
    competitionId: f.competition,
    name: `Tim ${f.suffix}`,
    captainId: f.target,
    status: "forming",
  });

  await tx.insert(teamMemberships).values({
    id: randomUUID(),
    teamId: f.team,
    userId: f.target,
    role: "captain",
    status: "active",
  });

  await tx.insert(competitionSubmissions).values({
    id: randomUUID(),
    registrationId: f.registration,
    submittedById: f.target,
    fileKey: `submissions/${f.competition}/${f.registration}/entry.pdf`,
    fileName: "entry-rina.pdf",
    fileMimeType: "application/pdf",
    finalizedAt: new Date(),
  });

  await tx.insert(competitionDocumentRequests).values({
    id: f.request,
    registrationId: f.registration,
    title: "Kartu pelajar",
    instructions: "Unggah kartu pelajar",
    dueAt: new Date(Date.now() + 7 * 86_400_000),
    status: "requested",
    requestedByUserId: f.bystander,
    reviewNote: "Kurang jelas, unggah ulang",
  });

  await tx.insert(competitionDocumentRequestFiles).values({
    id: randomUUID(),
    requestId: f.request,
    r2Key: `registration-documents/${f.competition}/${f.registration}/${f.request}/scan.pdf`,
    originalFileName: "scan-rina.pdf",
    fileSizeBytes: 512,
    contentType: "application/pdf",
  });

  await tx.insert(competitionResults).values({
    id: randomUUID(),
    registrationId: f.registration,
    competitionId: f.competition,
    resultStatus: "published",
    resultLabel: "Juara 1",
    resultNotes: "Catatan hasil tentang Rina",
    publishedAt: new Date(),
  });

  await tx.insert(competitionReviews).values({
    id: randomUUID(),
    competitionId: f.competition,
    authorUserId: f.target,
    rating: 5,
    body: "Ulasan pribadi Rina",
  });

  await tx.insert(recruiterVerificationSubmissions).values({
    id: f.recruiterSubmission,
    userId: f.target,
    fullName: f.targetName,
    mobileNumber: "+628123456789",
    status: "draft",
  });

  await tx.insert(recruiterVerificationDocuments).values({
    id: randomUUID(),
    submissionId: f.recruiterSubmission,
    r2Key: `recruiter-verification/${f.target}/${f.recruiterSubmission}/ktp.pdf`,
    originalFileName: "ktp.pdf",
    fileSizeBytes: 256,
    contentType: "application/pdf",
  });

  await tx.insert(platformOpsNotes).values({
    id: randomUUID(),
    targetUserId: f.target,
    note: "Catatan operator tentang akun ini",
    createdById: f.operator,
  });

  await tx.insert(institutionInvitations).values([
    {
      id: randomUUID(),
      institutionId: f.institution,
      invitedEmail: f.targetEmail,
      invitedRole: "institution_staff",
      tokenHash: `hash-a-${f.suffix}`,
      status: "pending",
      targetUserId: f.target,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
    {
      id: randomUUID(),
      institutionId: f.institution,
      invitedEmail: f.targetEmail,
      invitedRole: "institution_staff",
      tokenHash: `hash-b-${f.suffix}`,
      status: "pending_claim",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  ]);

  await tx.insert(teamInvitations).values({
    id: randomUUID(),
    teamId: f.team,
    invitedEmail: f.targetEmail,
    tokenHash: `hash-c-${f.suffix}`,
    status: "pending",
    targetUserId: f.target,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });

  await tx.insert(accounts).values({
    userId: f.target,
    type: "oauth",
    provider: "google",
    providerAccountId: `google-${f.suffix}`,
  });

  await tx.insert(sessions).values({
    sessionToken: `session-${f.suffix}`,
    userId: f.target,
    expires: new Date(Date.now() + 30 * 86_400_000),
  });

  await tx.insert(userPasswordCredentials).values({
    userId: f.target,
    passwordHash: "hash-fixture",
  });

  await tx.insert(userEmailVerificationTokens).values({
    id: randomUUID(),
    userId: f.target,
    tokenHash: `verify-${f.suffix}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  await tx.insert(mfaFactors).values({
    id: randomUUID(),
    userId: f.target,
    encryptedSecret: "enc",
    secretIv: "iv",
    secretAuthTag: "tag",
    verifiedAt: new Date(),
  });

  await tx.insert(mfaRecoveryCodes).values({
    id: randomUUID(),
    userId: f.target,
    codeHash: `recovery-${f.suffix}`,
  });

  await tx.insert(userPlatformRoles).values({ userId: f.target, role: "finance_ops" });

  await tx.insert(profileSkills).values({ id: randomUUID(), userId: f.target, name: "Desain" });

  await tx.insert(profileCertifications).values({
    id: randomUUID(),
    userId: f.target,
    name: "Sertifikat Rina",
    issuer: "Lembaga",
  });

  await tx.insert(notifications).values({
    id: randomUUID(),
    userId: f.target,
    type: "registration_confirmed",
    title: "Pendaftaran diterima",
    body: "Rina",
  });

  await tx.insert(competitionSaves).values({ userId: f.target, competitionId: f.competition });

  await tx.insert(verificationTokens).values({
    identifier: f.targetEmail,
    token: `vt-${f.suffix}`,
    expires: new Date(Date.now() + 86_400_000),
  });

  // The objects the action is expected to remove, plus two it must leave alone: a payment proof
  // behind an immutable ledger row, and a bystander's avatar.
  r2.objects.push(
    `avatars/${f.target}/a.jpg`,
    `banners/${f.target}/b.jpg`,
    `resumes/${f.target}/cv.pdf`,
    `profile-certifications/${f.target}/cert.pdf`,
    `recruiter-verification/${f.target}/${f.recruiterSubmission}/ktp.pdf`,
    `submissions/${f.competition}/${f.registration}/entry.pdf`,
    `registration-documents/${f.competition}/${f.registration}/${f.request}/scan.pdf`,
    `institution-logos/${f.institution}/logo.png`,
    `institution-banners/${f.institution}/banner.png`,
    `payment-instructions/${f.institution}/qris.png`,
    `verification/${f.institution}/${f.verificationSubmission}/ktp.pdf`,
    `payment-proofs/${f.competition}/${f.payment}/proof.jpg`,
    `avatars/${f.bystander}/other.jpg`,
  );

  return f;
};

/** Every object key the action is expected to have removed, for the fixture it ran on. */
const expectedDeletedKeys = (f: Fixture): string[] => [
  `avatars/${f.target}/a.jpg`,
  `banners/${f.target}/b.jpg`,
  `resumes/${f.target}/cv.pdf`,
  `profile-certifications/${f.target}/cert.pdf`,
  `recruiter-verification/${f.target}/${f.recruiterSubmission}/ktp.pdf`,
  `submissions/${f.competition}/${f.registration}/entry.pdf`,
  `registration-documents/${f.competition}/${f.registration}/${f.request}/scan.pdf`,
  `institution-logos/${f.institution}/logo.png`,
  `institution-banners/${f.institution}/banner.png`,
  `payment-instructions/${f.institution}/qris.png`,
  `verification/${f.institution}/${f.verificationSubmission}/ktp.pdf`,
];

/** Every prefix the action is expected to have listed, spelled out rather than derived. */
const expectedPrefixes = (f: Fixture): string[] => [
  `avatars/${f.target}/`,
  `banners/${f.target}/`,
  `resumes/${f.target}/`,
  `profile-certifications/${f.target}/`,
  `recruiter-verification/${f.target}/`,
  `submissions/${f.competition}/${f.registration}/`,
  `registration-documents/${f.competition}/${f.registration}/`,
  `institution-logos/${f.institution}/`,
  `institution-banners/${f.institution}/`,
  `payment-instructions/${f.institution}/`,
  `verification/${f.institution}/`,
];

const countRows = async (tx: Tx, table: string, column: string, value: string): Promise<number> => {
  const rows = await tx.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${value}`,
  );

  return (rows[0] as { n: number }).n;
};

const readUser = async (tx: Tx, id: string) => {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);

  return row;
};

beforeEach(() => {
  r2.available = true;
  r2.objects = [];
  r2.listed = [];
  r2.deleted = [];
  r2.failFrom = null;
});

describe.skipIf(skipWithoutDatabase)("deidentifyAccount", () => {
  describe("the refusals, none of which removes anything", () => {
    it("refuses 503 when storage is not configured, before it reads the target", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        r2.available = false;

        const error = await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_storage_unavailable",
          503,
        );

        expect(error.message).not.toContain(f.target);
        expect(r2.listed).toEqual([]);
        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses 400 when the reason is empty once trimmed", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await expectCode(
          run(tx, f.operator, f.target, { confirmUsername: f.targetUsername, reason: "   " }),
          "deidentify_reason_required",
          400,
        );

        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses when the operator targets their own account", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        const error = await rejection(
          run(tx, f.operator, f.operator, {
            confirmUsername: `deident_ops_${f.suffix}`,
            reason: "permintaan pemilik",
          }),
        );

        expect(error).toBeInstanceOf(OperatorActorError);
        expect((error as OperatorActorError).code).toBe("operator_actor_is_target");
        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses 404 for an account that does not exist", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await expectCode(
          run(tx, f.operator, randomUUID(), {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_account_not_found",
          404,
        );
      });
    });

    it("refuses 403 when the target is itself an operator account", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        const otherOperator = randomUUID();
        const otherUsername = `deident_ops2_${f.suffix}`;

        await tx.insert(users).values({
          id: otherOperator,
          email: `deident_ops2_${f.suffix}@example.test`,
          username: otherUsername,
          name: "Second Ops Fixture",
          role: "platform_ops",
          candidateVerifiedAt: new Date(),
        });

        await expectCode(
          run(tx, f.operator, otherOperator, {
            confirmUsername: otherUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_target_is_operator",
          403,
        );

        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses 400 when the typed confirmation differs, casing included", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername.toUpperCase(),
            reason: "permintaan pemilik",
          }),
          "deidentify_confirmation_mismatch",
          400,
        );

        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses 409 when the target is the last active owner of a full institution", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        const sharedSlug = `shared-${f.suffix}`;
        const shared = randomUUID();

        await tx.insert(institutions).values({
          id: shared,
          slug: sharedSlug,
          institutionType: "company",
          displayName: "Shared Fixture",
          status: "active",
        });

        await tx.insert(institutionMemberships).values({
          id: randomUUID(),
          institutionId: shared,
          userId: f.target,
          membershipRole: "institution_owner",
          status: "active",
        });

        const error = await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_last_owner",
          409,
        );

        expect(error.message).toContain(sharedSlug);
        expect(r2.deleted).toEqual([]);
      });
    });

    it("does not refuse for a full institution that has another active owner", async () => {
      // The narrowing is the point of the predicate: it is LAST active owner, so an institution with
      // a second one must not stop the action.
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        const shared = randomUUID();

        await tx.insert(institutions).values({
          id: shared,
          slug: `shared2-${f.suffix}`,
          institutionType: "company",
          displayName: "Shared Fixture Two",
          status: "active",
        });

        await tx.insert(institutionMemberships).values([
          {
            id: randomUUID(),
            institutionId: shared,
            userId: f.target,
            membershipRole: "institution_owner",
            status: "active",
          },
          {
            id: randomUUID(),
            institutionId: shared,
            userId: f.bystander,
            membershipRole: "institution_owner",
            status: "active",
          },
        ]);

        const result = await run(tx, f.operator, f.target, {
          confirmUsername: f.targetUsername,
          reason: "permintaan pemilik",
        });

        expect(result.personalInstitutionId).toBe(f.institution);
        expect(await countRows(tx, "institution_memberships", "user_id", f.target)).toBe(2);
      });
    });

    it("refuses 409 when the target's personal institution has a published competition", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        const publishedSlug = `published-${f.suffix}`;

        await tx
          .update(competitions)
          .set({ status: "published", slug: publishedSlug })
          .where(eq(competitions.id, f.competition));

        const error = await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_personal_institution_has_published_competition",
          409,
        );

        expect(error.message).toContain(publishedSlug);
        expect(r2.deleted).toEqual([]);
      });
    });

    it("refuses 409 already-done for an account that is deactivated with no objects left", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await tx.update(users).set({ status: "deactivated" }).where(eq(users.id, f.target));
        r2.objects = [];

        await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_already_done",
          409,
        );

        expect(r2.deleted).toEqual([]);
      });
    });

    it("does not refuse a deactivated target whose objects are still there", async () => {
      // The clause is the conjunction, not the status on its own. A deactivated row with objects
      // still under the target's prefixes passes the pre-read; the writing transaction is told to
      // re-run every precondition EXCEPT this one, so it refuses there — and the refusal keeps the
      // code it was raised with, because the rehearsal's 500 is for faults the service cannot name.
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await tx.update(users).set({ status: "deactivated" }).where(eq(users.id, f.target));

        await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_already_done",
          409,
        );

        expect(r2.deleted).toEqual([]);
        expect(r2.objects).toContain(`avatars/${f.target}/a.jpg`);
      });
    });
  });

  describe("a full run against the seeded account", () => {
    it("removes, scrubs and accounts for everything the fixture planted", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        const result = await run(tx, f.operator, f.target, {
          confirmUsername: f.targetUsername,
          reason: "  permintaan melalui email  ",
        });

        expect(result.personalInstitutionId).toBe(f.institution);

        // ---- storage -------------------------------------------------------------------------
        expect(result.objectsDeleted).toBe(expectedDeletedKeys(f).length);
        expect([...r2.deleted].sort()).toEqual([...expectedDeletedKeys(f)].sort());

        for (const prefix of expectedPrefixes(f)) {
          expect(r2.listed, `${prefix} was never listed`).toContain(prefix);
        }

        expect(r2.listed.some((prefix) => prefix.startsWith("payment-proofs/"))).toBe(false);
        expect(r2.deleted.some((key) => key.startsWith("payment-proofs/"))).toBe(false);
        expect(r2.objects).toContain(`payment-proofs/${f.competition}/${f.payment}/proof.jpg`);
        expect(r2.objects).toContain(`avatars/${f.bystander}/other.jpg`);

        // ---- the tombstone -------------------------------------------------------------------
        const user = await readUser(tx, f.target);

        expect(user).toBeDefined();
        expect(user!.name).toBe("Akun dihapus");
        expect(user!.email).toBe(`deleted+${f.target}@deleted.invalid`);
        expect(user!.username).toBe(`deleted-${f.target}`);
        expect(user!.image).toBeNull();
        expect(user!.status).toBe("deactivated");
        expect(user!.suspendedAt).not.toBeNull();
        expect(user!.suspensionReason).toBe("Akun dihapus atas permintaan pemilik");
        // Not what this action is about, and a reader of the trail still needs them.
        expect(user!.candidateVerifiedAt).not.toBeNull();
        expect(user!.recruiterVerificationTier).toBe("unverified");

        // ---- every DELETE set is empty for U --------------------------------------------------
        const perTarget: [string, string][] = [
          ["accounts", "user_id"],
          ["sessions", "user_id"],
          ["user_password_credentials", "user_id"],
          ["user_email_verification_tokens", "user_id"],
          ["mfa_factors", "user_id"],
          ["mfa_recovery_codes", "user_id"],
          ["user_platform_roles", "user_id"],
          ["profile_certifications", "user_id"],
          ["profile_educations", "user_id"],
          ["profile_experiences", "user_id"],
          ["profile_skills", "user_id"],
          ["profile_social_links", "user_id"],
          ["notifications", "user_id"],
          ["competition_saves", "user_id"],
          ["candidate_profiles", "user_id"],
          ["platform_ops_notes", "target_user_id"],
          ["recruiter_verification_submissions", "user_id"],
          ["institution_invitations", "target_user_id"],
          ["team_invitations", "target_user_id"],
        ];

        for (const [table, column] of perTarget) {
          expect(await countRows(tx, table, column, f.target), `${table} still holds a row`).toBe(
            0,
          );
        }

        // Both invitation rows went, and the second carried no targetUserId at all — it was
        // addressed by an address that resolves to the person.
        expect(await countRows(tx, "institution_invitations", "invited_email", f.targetEmail)).toBe(
          0,
        );
        expect(await countRows(tx, "team_invitations", "invited_email", f.targetEmail)).toBe(0);
        expect(await countRows(tx, "verification_tokens", "identifier", f.targetEmail)).toBe(0);
        expect(
          await countRows(
            tx,
            "recruiter_verification_documents",
            "submission_id",
            f.recruiterSubmission,
          ),
        ).toBe(0);
        expect(
          await countRows(tx, "competition_document_request_files", "request_id", f.request),
        ).toBe(0);

        // The bystander's own row is where it was.
        expect(await countRows(tx, "competition_registrations", "student_id", f.bystander)).toBe(1);

        // ---- the scrubs -----------------------------------------------------------------------
        const [profile] = await tx
          .select()
          .from(userProfiles)
          .where(eq(userProfiles.userId, f.target))
          .limit(1);

        expect(profile).toBeDefined();
        expect(profile!.displayName).toBe("Akun dihapus");
        expect(profile!.phoneNumber).toBeNull();
        expect(profile!.avatarUrl).toBeNull();
        expect(profile!.avatarR2Key).toBeNull();
        expect(profile!.bannerR2Key).toBeNull();
        expect(profile!.summary).toBeNull();
        expect(profile!.location).toBeNull();
        expect(profile!.resumeR2Key).toBeNull();
        expect(profile!.resumeFileName).toBeNull();
        expect(profile!.resumeSizeBytes).toBeNull();
        expect(profile!.resumeMimeType).toBeNull();
        expect(profile!.resumeUploadedAt).toBeNull();
        expect(profile!.resumePublic).toBe(false);

        const [registration] = await tx
          .select()
          .from(competitionRegistrations)
          .where(eq(competitionRegistrations.id, f.registration))
          .limit(1);

        expect(registration!.internalNotes).toBeNull();
        expect(registration!.status).toBe("confirmed");

        const [resultRow] = await tx
          .select()
          .from(competitionResults)
          .where(eq(competitionResults.registrationId, f.registration))
          .limit(1);

        expect(resultRow!.resultNotes).toBeNull();
        expect(resultRow!.resultLabel).toBe("Juara 1");

        const [submission] = await tx
          .select()
          .from(competitionSubmissions)
          .where(eq(competitionSubmissions.registrationId, f.registration))
          .limit(1);

        expect(submission!.fileKey).toBe("[dihapus]");
        expect(submission!.fileName).toBe("[dihapus]");

        const [request] = await tx
          .select()
          .from(competitionDocumentRequests)
          .where(eq(competitionDocumentRequests.id, f.request))
          .limit(1);

        expect(request!.reviewNote).toBeNull();
        expect(request!.title).toBe("Kartu pelajar");
        expect(request!.instructions).toBe("Unggah kartu pelajar");

        const [review] = await tx
          .select()
          .from(competitionReviews)
          .where(eq(competitionReviews.authorUserId, f.target))
          .limit(1);

        expect(review!.body).toBeNull();
        expect(review!.rating).toBe(5);

        const [membership] = await tx
          .select()
          .from(institutionMemberships)
          .where(eq(institutionMemberships.institutionId, f.institution))
          .limit(1);

        expect(membership!.status).toBe("revoked");

        // ---- the personal institution ---------------------------------------------------------
        const [institution] = await tx
          .select()
          .from(institutions)
          .where(eq(institutions.id, f.institution))
          .limit(1);

        expect(institution!.displayName).toBe("Institusi dihapus");
        expect(institution!.slug).toBe(`deleted-${f.institution}`);
        expect(institution!.suspendedAt).not.toBeNull();
        expect(institution!.suspensionReason).toBe("Pemilik akun meminta penghapusan data");
        expect(institution!.description).toBeNull();
        expect(institution!.rejectionReason).toBeNull();
        expect(institution!.logoR2Key).toBeNull();
        expect(institution!.bannerR2Key).toBeNull();
        expect(institution!.about).toBeNull();
        expect(institution!.contactName).toBeNull();
        expect(institution!.contactEmail).toBeNull();
        expect(institution!.contactPhone).toBeNull();
        expect(institution!.websiteUrl).toBeNull();
        // Not text a person wrote, and a reader of the taxonomy still needs them.
        expect(institution!.status).toBe("active");
        expect(institution!.verificationStatus).toBe("verified");
        expect(institution!.institutionType).toBe("personal");

        expect(
          await countRows(tx, "institution_social_links", "institution_id", f.institution),
        ).toBe(0);
        expect(
          await countRows(tx, "institution_payment_instructions", "institution_id", f.institution),
        ).toBe(0);

        const [verificationDocument] = await tx
          .select()
          .from(institutionVerificationDocuments)
          .where(eq(institutionVerificationDocuments.submissionId, f.verificationSubmission))
          .limit(1);

        expect(verificationDocument!.documentType).toBe("[dihapus]");
        expect(verificationDocument!.r2Key).toBe("[dihapus]");
        expect(verificationDocument!.originalFileName).toBe("[dihapus]");
        expect(verificationDocument!.contentType).toBe("[dihapus]");

        // The submission the documents hang off survives, with what it held of the person removed:
        // the name they would have traded under, and the reviewer's prose about them.
        const [verificationSubmission] = await tx
          .select()
          .from(institutionVerificationSubmissions)
          .where(eq(institutionVerificationSubmissions.id, f.verificationSubmission))
          .limit(1);

        expect(verificationSubmission).toBeDefined();
        expect(verificationSubmission!.proposedDisplayName).toBeNull();
        expect(verificationSubmission!.reviewerNotes).toBeNull();
        expect(verificationSubmission!.status).toBe("pending_review");

        // ---- what other people depend on ------------------------------------------------------
        expect(await countRows(tx, "team_memberships", "user_id", f.target)).toBe(1);

        const [teamMembership] = await tx
          .select()
          .from(teamMemberships)
          .where(eq(teamMemberships.userId, f.target))
          .limit(1);

        expect(teamMembership!.status).toBe("active");

        const [team] = await tx.select().from(teams).where(eq(teams.id, f.team)).limit(1);

        expect(team!.captainId).toBe(f.target);
        expect(team!.name).toBe(`Tim ${f.suffix}`);

        const [otherRegistration] = await tx
          .select()
          .from(competitionRegistrations)
          .where(eq(competitionRegistrations.id, f.otherRegistration))
          .limit(1);

        expect(otherRegistration!.internalNotes).toBe("Catatan internal tentang bystander");

        // ---- exactly one audit row, carrying nothing personal ---------------------------------
        const audit = await tx
          .select()
          .from(platformOpsAuditLogs)
          .where(eq(platformOpsAuditLogs.targetUserId, f.target));

        expect(audit.length).toBe(1);
        expect(audit[0]!.eventType).toBe("account_deidentified");
        expect(audit[0]!.actorUserId).toBe(f.operator);
        expect(audit[0]!.reason).toBe("permintaan melalui email");

        const metadata = audit[0]!.metadata as {
          rowsDeleted: Record<string, number>;
          rowsScrubbed: Record<string, number>;
          personalInstitutionId: string | null;
        };

        expect(metadata.personalInstitutionId).toBe(f.institution);
        expect(metadata.rowsDeleted.candidate_profiles).toBe(1);
        expect(metadata.rowsDeleted.notifications).toBe(1);
        expect(metadata.rowsDeleted.competition_document_request_files).toBe(1);
        expect(metadata.rowsScrubbed.user_profiles).toBe(1);
        expect(metadata.rowsScrubbed.competition_submissions).toBe(1);
        expect(metadata.rowsScrubbed.institutions).toBe(1);
        expect(metadata.rowsScrubbed.institution_verification_submissions).toBe(1);

        const serialised = JSON.stringify(audit[0]);

        for (const personal of [
          f.targetEmail,
          f.targetUsername,
          f.targetName,
          "+628123456789",
          "Bandung",
          "Catatan operator tentang akun ini",
        ]) {
          expect(serialised, `${personal} reached the audit row`).not.toContain(personal);
        }
      });
    });

    it("leaves an account no sign-in path can resolve", async () => {
      // Read-only assertions against the tables the auth paths read. Nothing under
      // `src/server/auth/` is touched by this step; what is shown is that the rows those paths
      // consult no longer answer for the person.
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        await run(tx, f.operator, f.target, {
          confirmUsername: f.targetUsername,
          reason: "permintaan pemilik",
        });

        const byOldAddress = await tx.execute(
          sql`select id from users where lower(email) = lower(${f.targetEmail})`,
        );
        const byOldUsername = await tx.execute(
          sql`select id from users where username = ${f.targetUsername}`,
        );
        const credential = await tx.execute(
          sql`select user_id from user_password_credentials where user_id = ${f.target}`,
        );
        const session = await tx.execute(
          sql`select user_id from sessions where user_id = ${f.target}`,
        );

        expect(byOldAddress.length).toBe(0);
        expect(byOldUsername.length).toBe(0);
        expect(credential.length).toBe(0);
        expect(session.length).toBe(0);

        const live = await readUser(tx, f.target);

        expect(live!.suspendedAt).not.toBeNull();
        expect(live!.status).toBe("deactivated");
      });
    });
  });

  describe("the rehearsal", () => {
    it("deletes no object and changes no row when a write would fail", async () => {
      // THE CONSTRAINT IS ADDED ON A SECOND CONNECTION, and it has to be. `DATABASE_URL` is
      // `lombakita_app`, which does not own these tables, so the same `alter table` on the test's own
      // connection is refused with `42501 must be owner of table user_profiles` — measured, not
      // assumed. `TEST_DDL_DATABASE_URL` is the owner, and exists for exactly this.
      //
      // Two consequences that shape the test rather than being incidental to it:
      //   - the DDL COMMITS, so it cannot live inside `inRollback`. The add happens before the
      //     transaction opens, and the drop is in a `finally` whose own failure cannot suppress it.
      //   - the predicate must be one the FIXTURE satisfies, because the fixture is built while the
      //     constraint is already in force. `summary is null` would refuse the fixture's own row;
      //     `display_name is distinct from 'Akun dihapus'` holds for every row that exists and is
      //     broken by the scrub, which is the violation this test is here to provoke.
      const constraint = `deident_probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const ddl = postgres(TEST_DDL_DATABASE_URL!, { max: 1 });

      try {
        await ddl.unsafe(
          `alter table user_profiles add constraint "${constraint}"
             check (display_name is distinct from 'Akun dihapus')`,
        );

        await inRollback(async (tx) => {
          const f = await buildFixture(tx);

          await expectCode(
            run(tx, f.operator, f.target, {
              confirmUsername: f.targetUsername,
              reason: "permintaan pemilik",
            }),
            "deidentify_rehearsal_failed",
            500,
          );

          // Storage runs after the rehearsal, so a failing rehearsal must not have reached it.
          expect(r2.deleted).toEqual([]);
          expect(r2.objects).toContain(`avatars/${f.target}/a.jpg`);

          const user = await readUser(tx, f.target);

          expect(user!.status).toBe("active");
          expect(user!.email).toBe(f.targetEmail);
          expect(user!.name).toBe(f.targetName);

          const [profile] = await tx
            .select()
            .from(userProfiles)
            .where(eq(userProfiles.userId, f.target))
            .limit(1);

          expect(profile!.displayName).toBe(f.targetName);
          expect(await countRows(tx, "sessions", "user_id", f.target)).toBe(1);
          expect(await countRows(tx, "candidate_profiles", "user_id", f.target)).toBe(1);
          expect(await countRows(tx, "platform_ops_audit_logs", "target_user_id", f.target)).toBe(
            0,
          );
        });
      } finally {
        await ddl.unsafe(`alter table user_profiles drop constraint if exists "${constraint}"`);
        await ddl.end();
      }

      const check = postgres(TEST_DDL_DATABASE_URL!, { max: 1 });

      try {
        const lingering =
          await check`select count(*)::int as n from pg_constraint where conname = ${constraint}`;

        expect(lingering[0]!.n, "the temporary constraint outlived its test").toBe(0);
      } finally {
        await check.end();
      }
    });
  });

  describe("ordering", () => {
    it("answers 502 with the count so far and changes no row when a list fails", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        r2.failFrom = `resumes/${f.target}/`;

        const error = await expectCode(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
          "deidentify_storage_failed",
          502,
        );

        // Avatars then banners went before resumes refused, and that count is what the operator is
        // told, so they know a rerun will finish the job.
        expect(r2.deleted.length).toBe(2);
        expect(error.message).toContain("2 berkas sudah terhapus");

        const user = await readUser(tx, f.target);

        expect(user!.status).toBe("active");
        expect(user!.email).toBe(f.targetEmail);
        expect(await countRows(tx, "sessions", "user_id", f.target)).toBe(1);
        expect(await countRows(tx, "candidate_profiles", "user_id", f.target)).toBe(1);
        expect(await countRows(tx, "platform_ops_audit_logs", "target_user_id", f.target)).toBe(0);
      });
    });

    it("finishes on a rerun, deleting only what the failed attempt left", async () => {
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);
        r2.failFrom = `resumes/${f.target}/`;

        await rejection(
          run(tx, f.operator, f.target, {
            confirmUsername: f.targetUsername,
            reason: "permintaan pemilik",
          }),
        );

        r2.failFrom = null;
        r2.deleted = [];

        const result = await run(tx, f.operator, f.target, {
          confirmUsername: f.targetUsername,
          reason: "permintaan pemilik",
        });

        // The failed attempt got through avatars and banners before resumes refused, and those
        // objects are already gone from the bucket — so the rerun removes the other nine and the
        // count it reports is nine, not the eleven the account started with.
        const remaining = expectedDeletedKeys(f).filter(
          (key) => !key.startsWith("avatars/") && !key.startsWith("banners/"),
        );

        expect(result.objectsDeleted).toBe(remaining.length);
        expect([...r2.deleted].sort()).toEqual([...remaining].sort());

        const user = await readUser(tx, f.target);

        expect(user!.status).toBe("deactivated");
      });
    });
  });

  describe("the actor", () => {
    it("is resolved by the writing transaction, not carried in from the pre-read", async () => {
      // Suspending the actor between the pre-read and the rehearsal is the move a stale actor cannot
      // survive. Were the writing transaction reusing the pre-read's actor, nothing would notice the
      // suspension: the rehearsal would pass, storage would be emptied, and the run would be recorded
      // against an operator the database had already stopped vouching for.
      await inRollback(async (tx) => {
        const f = await buildFixture(tx);

        const error = await rejection(
          run(
            tx,
            f.operator,
            f.target,
            { confirmUsername: f.targetUsername, reason: "permintaan pemilik" },
            {
              beforeTransaction: {
                nth: 2,
                run: async () => {
                  await tx
                    .update(users)
                    .set({ suspendedAt: new Date() })
                    .where(eq(users.id, f.operator));
                },
              },
            },
          ),
        );

        // The refusal keeps the identity it was raised with. The re-resolution happens inside the
        // rehearsal transaction, and a suspended operator is a fact this service already knows how to
        // name; the rehearsal's 500 is reserved for faults it cannot classify.
        expect(error).toBeInstanceOf(OperatorActorError);
        expect((error as OperatorActorError).code).toBe("operator_actor_suspended");
        expect((error as OperatorActorError).status).toBe(403);

        // The proof that matters: the suspension was seen before anything irreversible happened.
        expect(r2.deleted).toEqual([]);

        const user = await readUser(tx, f.target);

        expect(user!.status).toBe("active");
        expect(await countRows(tx, "platform_ops_audit_logs", "target_user_id", f.target)).toBe(0);
      });
    });
  });
});
