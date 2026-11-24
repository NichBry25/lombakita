import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { EMAIL_SHAPE, normalizeEmail } from "@/server/auth/credentials-auth";
import { sendOrganizationEmailCode } from "@/server/auth/email-verification";
import { ORGANIZATION_EMAIL_DOMAIN_TRY_LIMIT } from "@/server/auth/rate-limit-constants";
import {
  hashRegistrationCode,
  issueRegistrationCode,
  REGISTRATION_CODE_TTL_MS,
  registrationCodeMatches,
} from "@/server/auth/registration-code";
import { getDb, type Database } from "@/server/db/client";
import { hostOrganizationEmails, organizationEmailChallenges, users } from "@/server/db/schema";
import {
  extractEmailDomain,
  holdsOnlyPrintableAscii,
  isFreeOrThrowawayEmailDomain,
  registrableDomainOf,
} from "@/server/host-trust/email-domain";
import {
  trustHostInTransaction,
  type AutomaticTrustSource,
} from "@/server/host-trust/host-trust-service";
import { acquireOrganizationEmailSendLocks } from "@/server/host-trust/organization-email-send-lock";
import { checkFixedWindowLimitFailClosed } from "@/server/redis/rate-limit";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/organization-email-service");

const ORGANIZATION_EMAIL_CODE_ATTEMPT_LIMIT = 5;
const ORGANIZATION_EMAIL_RESEND_SECONDS = 60;
const ORGANIZATION_EMAIL_DAILY_SENDS_PER_ADDRESS = 5;
const ORGANIZATION_EMAIL_DAILY_SENDS_PER_ACCOUNT = 10;

const INVALID_EMAIL_MESSAGE = "Alamat email belum benar. Periksa lagi penulisannya.";
const DAILY_LIMIT_MESSAGE = "Batas pengiriman kode hari ini sudah tercapai. Coba lagi besok.";
const NO_CODE_MESSAGE = "Belum ada kode yang aktif. Minta kode terlebih dahulu.";
const CODE_LOCKED_MESSAGE = "Kode salah 5 kali. Minta kode baru.";
const DOMAIN_TRY_LIMIT_MESSAGE =
  "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.";
const CODE_CHECK_UNAVAILABLE_MESSAGE =
  "Konfirmasi kode sedang tidak tersedia. Coba lagi beberapa saat.";
const EMAIL_TAKEN_MESSAGE =
  "Email ini sudah dipakai akun lain. Satu email organisasi hanya untuk satu akun.";

export type OrganizationEmailErrorCode =
  | "organization_email_invalid"
  | "organization_email_free_domain"
  | "organization_email_resend_too_soon"
  | "organization_email_daily_limit"
  | "organization_email_no_code"
  | "organization_email_code_expired"
  | "organization_email_code_locked"
  | "organization_email_code_invalid"
  | "organization_email_taken";

export class OrganizationEmailError extends Error {
  constructor(
    public readonly code: OrganizationEmailErrorCode,
    public readonly status: 400 | 404 | 409 | 422 | 429,
    message: string,
    public readonly details?: { retryAfterSeconds?: number; attemptsLeft?: number },
  ) {
    super(message);
  }
}

export const toOrganizationEmailErrorResponse = (error: OrganizationEmailError): NextResponse => {
  return NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status },
  );
};

const readOrganizationEmailDomainOrRefuse = (email: string): string => {
  if (!holdsOnlyPrintableAscii(email)) {
    throw new OrganizationEmailError("organization_email_invalid", 400, INVALID_EMAIL_MESSAGE);
  }
  if (!EMAIL_SHAPE.test(email)) {
    throw new OrganizationEmailError("organization_email_invalid", 400, INVALID_EMAIL_MESSAGE);
  }

  const domain = extractEmailDomain(email);
  if (domain === null) {
    throw new OrganizationEmailError("organization_email_invalid", 400, INVALID_EMAIL_MESSAGE);
  }

  if (isFreeOrThrowawayEmailDomain(domain)) {
    throw new OrganizationEmailError(
      "organization_email_free_domain",
      422,
      "Pakai email dengan domain organisasi Anda, bukan email pribadi seperti Gmail atau email sementara.",
    );
  }
  return domain;
};

const refuseWhenSendLimitReached = async (
  tx: Database,
  userId: string,
  email: string,
): Promise<void> => {
  const resendWindow = sql`${ORGANIZATION_EMAIL_RESEND_SECONDS}::int * interval '1 second'`;

  const [recentSend] = await tx
    .select({
      secondsLeft: sql<number>`ceil(extract(epoch from (${organizationEmailChallenges.createdAt} + ${resendWindow} - now())))::int`,
    })
    .from(organizationEmailChallenges)
    .where(
      and(
        eq(organizationEmailChallenges.userId, userId),
        eq(organizationEmailChallenges.email, email),
        gt(organizationEmailChallenges.createdAt, sql`now() - ${resendWindow}`),
      ),
    )
    .orderBy(desc(organizationEmailChallenges.createdAt))
    .limit(1);
  if (recentSend) {
    const secondsToWait = Math.max(recentSend.secondsLeft, 1);
    throw new OrganizationEmailError(
      "organization_email_resend_too_soon",
      429,
      `Tunggu ${secondsToWait} detik sebelum meminta kode baru.`,
      { retryAfterSeconds: secondsToWait },
    );
  }

  const sentInLastDay = gt(organizationEmailChallenges.createdAt, sql`now() - interval '24 hours'`);

  const [sentToAddress] = await tx
    .select({ sends: sql<number>`count(*)::int` })
    .from(organizationEmailChallenges)
    .where(and(eq(organizationEmailChallenges.email, email), sentInLastDay));
  if ((sentToAddress?.sends ?? 0) >= ORGANIZATION_EMAIL_DAILY_SENDS_PER_ADDRESS) {
    throw new OrganizationEmailError("organization_email_daily_limit", 429, DAILY_LIMIT_MESSAGE);
  }

  const [sentByAccount] = await tx
    .select({ sends: sql<number>`count(*)::int` })
    .from(organizationEmailChallenges)
    .where(and(eq(organizationEmailChallenges.userId, userId), sentInLastDay));
  if ((sentByAccount?.sends ?? 0) >= ORGANIZATION_EMAIL_DAILY_SENDS_PER_ACCOUNT) {
    throw new OrganizationEmailError("organization_email_daily_limit", 429, DAILY_LIMIT_MESSAGE);
  }
};

export const issueOrganizationEmailCode = async (
  userId: string,
  rawEmail: string,
  db: Database = getDb(),
): Promise<{ email: string; expiresAt: Date }> => {
  const email = normalizeEmail(rawEmail);
  const domain = readOrganizationEmailDomainOrRefuse(email);

  const code = issueRegistrationCode();
  const challengeId = randomUUID();

  const expiresAt = await db.transaction(async (tx) => {
    await tx
      .delete(organizationEmailChallenges)
      .where(lt(organizationEmailChallenges.createdAt, sql`now() - interval '24 hours'`));
    await acquireOrganizationEmailSendLocks(tx, userId, email);
    await refuseWhenSendLimitReached(tx, userId, email);

    const [challenge] = await tx
      .insert(organizationEmailChallenges)
      .values({
        id: challengeId,
        userId,
        email,
        codeHash: hashRegistrationCode(challengeId, code),
        expiresAt: new Date(Date.now() + REGISTRATION_CODE_TTL_MS),
      })
      .returning({ expiresAt: organizationEmailChallenges.expiresAt });
    return challenge!.expiresAt;
  });

  await sendOrganizationEmailCode({ userId, email, domain, code });
  return { email, expiresAt };
};

const countDomainTryOrRefuse = async (challengeEmail: string): Promise<void> => {
  const domain = extractEmailDomain(challengeEmail)!;
  const organizationDomain = registrableDomainOf(domain);
  const decision = await checkFixedWindowLimitFailClosed({
    key: `${ORGANIZATION_EMAIL_DOMAIN_TRY_LIMIT.keyPrefix}${organizationDomain}`,
    limit: ORGANIZATION_EMAIL_DOMAIN_TRY_LIMIT.limit,
    windowSeconds: ORGANIZATION_EMAIL_DOMAIN_TRY_LIMIT.windowSeconds,
  });
  if (decision.decision === "allowed") return;

  const message =
    decision.decision === "throttled" ? DOMAIN_TRY_LIMIT_MESSAGE : CODE_CHECK_UNAVAILABLE_MESSAGE;
  throw new OrganizationEmailError("organization_email_code_locked", 422, message);
};

const claimCodeAttempt = async (
  db: Database,
  challengeId: string,
): Promise<{ codeHash: string; failedAttempts: number } | null> => {
  const [claimed] = await db
    .update(organizationEmailChallenges)
    .set({ failedAttempts: sql`${organizationEmailChallenges.failedAttempts} + 1` })
    .where(
      and(
        eq(organizationEmailChallenges.id, challengeId),
        isNull(organizationEmailChallenges.consumedAt),
        lt(organizationEmailChallenges.failedAttempts, ORGANIZATION_EMAIL_CODE_ATTEMPT_LIMIT),
        gt(organizationEmailChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({
      codeHash: organizationEmailChallenges.codeHash,
      failedAttempts: organizationEmailChallenges.failedAttempts,
    });
  return claimed ?? null;
};

const refuseUnclaimedAttempt = async (db: Database, challengeId: string): Promise<never> => {
  const [challenge] = await db
    .select({
      consumedAt: organizationEmailChallenges.consumedAt,
      failedAttempts: organizationEmailChallenges.failedAttempts,
    })
    .from(organizationEmailChallenges)
    .where(eq(organizationEmailChallenges.id, challengeId))
    .limit(1);

  if (!challenge || challenge.consumedAt !== null) {
    throw new OrganizationEmailError("organization_email_no_code", 404, NO_CODE_MESSAGE);
  }
  if (challenge.failedAttempts >= ORGANIZATION_EMAIL_CODE_ATTEMPT_LIMIT) {
    throw new OrganizationEmailError("organization_email_code_locked", 422, CODE_LOCKED_MESSAGE);
  }
  throw new OrganizationEmailError(
    "organization_email_code_expired",
    422,
    "Kode sudah kedaluwarsa. Minta kode baru.",
  );
};

const refuseWhenOrganizationEmailTaken = async (
  tx: Database,
  userId: string,
  challengeEmail: string,
): Promise<void> => {
  const [otherAccountSigningInWithIt] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(ne(users.id, userId), sql`lower(${users.email}) = ${challengeEmail}`))
    .limit(1);
  if (otherAccountSigningInWithIt) {
    throw new OrganizationEmailError("organization_email_taken", 409, EMAIL_TAKEN_MESSAGE);
  }

  const [otherAccountHoldingItAsOrganizationEmail] = await tx
    .select({ userId: hostOrganizationEmails.userId })
    .from(hostOrganizationEmails)
    .where(
      and(
        ne(hostOrganizationEmails.userId, userId),
        eq(hostOrganizationEmails.email, challengeEmail),
      ),
    )
    .limit(1);
  if (otherAccountHoldingItAsOrganizationEmail) {
    throw new OrganizationEmailError("organization_email_taken", 409, EMAIL_TAKEN_MESSAGE);
  }
};

export const confirmOrganizationEmailCode = async (
  userId: string,
  code: string,
  db: Database = getDb(),
): Promise<{ email: string; trustSource: AutomaticTrustSource | null }> => {
  const [challenge] = await db
    .select({
      id: organizationEmailChallenges.id,
      email: organizationEmailChallenges.email,
      claimable: sql<boolean>`${organizationEmailChallenges.failedAttempts} < ${ORGANIZATION_EMAIL_CODE_ATTEMPT_LIMIT} and ${organizationEmailChallenges.expiresAt} > now()`,
    })
    .from(organizationEmailChallenges)
    .where(
      and(
        eq(organizationEmailChallenges.userId, userId),
        isNull(organizationEmailChallenges.consumedAt),
      ),
    )
    .orderBy(desc(organizationEmailChallenges.createdAt))
    .limit(1);
  if (!challenge) {
    throw new OrganizationEmailError("organization_email_no_code", 404, NO_CODE_MESSAGE);
  }

  // A challenge that cannot be claimed is refused before the domain count, so a request that is never
  // compared spends no try of the organization's domain.
  if (!challenge.claimable) return refuseUnclaimedAttempt(db, challenge.id);

  await countDomainTryOrRefuse(challenge.email);

  // The attempt is claimed and committed before any compare, so parallel guesses cannot pass the limit together.
  const claimed = await claimCodeAttempt(db, challenge.id);
  if (!claimed) return refuseUnclaimedAttempt(db, challenge.id);

  if (!registrationCodeMatches(claimed.codeHash, challenge.id, code)) {
    const attemptsLeft = ORGANIZATION_EMAIL_CODE_ATTEMPT_LIMIT - claimed.failedAttempts;
    throw new OrganizationEmailError(
      "organization_email_code_invalid",
      422,
      `Kode tidak cocok. Sisa percobaan: ${attemptsLeft}.`,
      { attemptsLeft },
    );
  }

  return db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(organizationEmailChallenges)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(organizationEmailChallenges.id, challenge.id),
          isNull(organizationEmailChallenges.consumedAt),
          gt(organizationEmailChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: organizationEmailChallenges.id });
    if (!consumed) {
      throw new OrganizationEmailError("organization_email_no_code", 404, NO_CODE_MESSAGE);
    }

    await refuseWhenOrganizationEmailTaken(tx, userId, challenge.email);

    await tx.delete(hostOrganizationEmails).where(eq(hostOrganizationEmails.userId, userId));
    const [recorded] = await tx
      .insert(hostOrganizationEmails)
      .values({
        userId,
        email: challenge.email,
        domain: extractEmailDomain(challenge.email)!,
        confirmedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ userId: hostOrganizationEmails.userId });
    if (!recorded) {
      throw new OrganizationEmailError("organization_email_taken", 409, EMAIL_TAKEN_MESSAGE);
    }

    const trustSource = await trustHostInTransaction(tx, userId);
    return { email: challenge.email, trustSource };
  });
};
