/**
 * The operator accounts, and the acts only an operator can perform on the testing matrix.
 *
 * SPLIT OUT OF THE MATRIX SEED, the way the money lane was, because the boundary has to live in the
 * module graph rather than in a flag: the default `npm run db:reset` path cannot create what it
 * does not import. Two facts decide it. The repository is public, so anything committed here is
 * known to everyone; and NO PRODUCT PATH CREATES A `platform_ops` OR `finance_ops` ACCOUNT
 * (`registerUserWithCredentials` accepts `candidate` and `recruiter` only, there is no operator
 * invitation flow, and no endpoint grants either role), so the account rows below are a raw
 * insert by necessity and not a routing gap. That absence is LAUNCH-D47's root and Block C2's
 * question.
 *
 * WHAT IS NOT COMMITTED. The password is the published seed password. The second factor is not:
 * each run enrols every factor through the production enrolment path, which mints a fresh secret,
 * so nothing in this file or in git is a usable second factor for any account this file creates.
 * The secrets a run minted are written to a git-ignored local file for the testing lane and the
 * operator running the Stage 9 checklist.
 *
 * WHAT TRAVELS A PRODUCTION PATH. The MFA factors (`startMfaEnrolment` → `confirmMfaEnrolment`,
 * which also mints recovery codes and writes `mfa.enrolled`), and the two verification reviews
 * (`reviewRecruiterVerification`, which on approval is what elevates a recruiter's tier and writes
 * `recruiter_verification.approved`, one story in the audit log rather than two). The raw writes are the
 * account rows and the factor reset that makes re-enrolment possible.
 */
import type { Sql } from "postgres";

export type OperatorAccount = {
  id: string;
  name: string;
  email: string;
  role: "platform_ops" | "finance_ops";
  username: string;
  /** Whether a run enrols a verified factor. `seed-user-ops-enrol` stays in enrolment_required. */
  enrolFactor: boolean;
};

export const OPERATOR_ACCOUNTS: readonly OperatorAccount[] = Object.freeze([
  {
    id: "seed-user-ops",
    name: "Ops Seed",
    email: "seed.ops@seed.lombakita.local",
    role: "platform_ops",
    username: "seed_ops",
    enrolFactor: true,
  },
  // The three MFA states an operational account can be in. `seed-user-ops` is the working operator
  // and every /admin surface is reachable once the harness elevates its session; these two sit
  // permanently in the gate as the fixtures for the enrolment and challenge pages themselves.
  {
    id: "seed-user-ops-enrol",
    name: "Ops Belum Enrol",
    email: "seed.ops.enrol@seed.lombakita.local",
    role: "platform_ops",
    username: "seed_ops_enrol",
    enrolFactor: false,
  },
  {
    id: "seed-user-ops-chal",
    name: "Ops Perlu Tantangan",
    email: "seed.ops.chal@seed.lombakita.local",
    role: "platform_ops",
    username: "seed_ops_chal",
    enrolFactor: true,
  },
  // finance_ops: the dispute reader. Distinct from platform_ops on purpose. The two roles reach
  // different shells and neither may reach the other's, which is what the audits assert.
  {
    id: "seed-user-fin",
    name: "Fina Operasional",
    email: "seed.fin@seed.lombakita.local",
    role: "finance_ops",
    username: "seed_fin",
    enrolFactor: true,
  },
]);

/** The operator every audited act in the seeds names as its actor. */
export const OPERATOR_ACTOR_ID = "seed-user-ops";

/** Where a run leaves the secrets it minted, for the testing lane and the Stage 9 operator. */
export const OPERATOR_SECRETS_FILE = "test-artifacts/seed-operator-secrets.json";

export type OperatorSecret = { secretBase32: string; secretHex: string; otpauthUri: string };

/**
 * Writes the account rows. Raw by necessity; see the header.
 *
 * `candidate_verified_at` is the `users_one_verified_role_chk` satisfier only (the migration-0015
 * carve-out) and deliberately no `candidate_profiles` row is written. The role and tier are set on
 * first insert only; nothing here demotes or re-roles an account on a re-run.
 */
export const seedOperatorAccountRows = async (
  sql: Sql,
  passwordHash: string,
  verifiedAt: Date,
): Promise<void> => {
  for (const account of OPERATOR_ACCOUNTS) {
    await sql`
      INSERT INTO users (id, name, email, email_verified, role, username, candidate_verified_at,
        recruiter_verified_at, recruiter_verification_tier)
      VALUES (${account.id}, ${account.name}, ${account.email}, ${verifiedAt}, ${account.role},
        ${account.username}, ${verifiedAt}, ${null}, 'unverified')
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, email = EXCLUDED.email, username = EXCLUDED.username,
        updated_at = now()
    `;
    await sql`
      INSERT INTO user_password_credentials (user_id, password_hash)
      VALUES (${account.id}, ${passwordHash})
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
    `;
    await sql`
      INSERT INTO user_profiles (user_id, display_name, summary, location)
      VALUES (${account.id}, ${account.name}, ${"Akun data uji (seed)."}, ${"Jakarta, Indonesia"})
      ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    `;
  }

  // Every factor is re-enrolled fresh below, and enrolment refuses an account that already holds a
  // verified one. This also returns `seed-user-ops-enrol` to enrolment_required after a harness
  // run enrolled it through the page it exists to exercise.
  await sql`
    DELETE FROM mfa_factors
    WHERE user_id IN ${sql(OPERATOR_ACCOUNTS.map((account) => account.id))}
  `;
};

export type MfaEnrolmentServices = {
  startMfaEnrolment: (userId: string) => Promise<{ secretBase32: string; otpauthUri: string }>;
  confirmMfaEnrolment: (userId: string, code: string, now: Date) => Promise<unknown>;
  generateTotpCode: (secret: Buffer, atSeconds: number) => string;
  base32Decode: (input: string) => Buffer;
};

/**
 * Enrols a verified factor for each account that carries one, through the production path.
 *
 * The confirmation code is generated from the secret the enrolment just returned, exactly as an
 * authenticator app would. Returns what the operator and the harness need to generate codes later.
 */
export const enrolOperatorFactors = async (
  services: MfaEnrolmentServices,
): Promise<Record<string, OperatorSecret>> => {
  const secrets: Record<string, OperatorSecret> = {};

  for (const account of OPERATOR_ACCOUNTS) {
    if (!account.enrolFactor) {
      continue;
    }

    const started = await services.startMfaEnrolment(account.id);
    const secret = services.base32Decode(started.secretBase32);
    const now = new Date();
    const code = services.generateTotpCode(secret, Math.floor(now.getTime() / 1000));

    await services.confirmMfaEnrolment(account.id, code, now);

    secrets[account.id] = {
      secretBase32: started.secretBase32,
      secretHex: secret.toString("hex"),
      otpauthUri: started.otpauthUri,
    };
  }

  return secrets;
};

export type ReviewService = {
  reviewRecruiterVerification: (
    reviewerUserId: string,
    submissionId: string,
    decision: "approve" | "reject",
    rejectionReason: string | null,
  ) => Promise<unknown>;
};

/** The reviews the matrix leaves pending for an operator to decide. */
export const OPERATOR_REVIEWS = Object.freeze([
  { submissionId: "seed-rvs-elev", decision: "approve", reason: null },
  {
    submissionId: "seed-rvs-rej",
    decision: "reject",
    reason: "Nomor tidak dapat dihubungi dan dokumen tidak jelas.",
  },
] as const);

/**
 * Decides the two pending reviews as `seed-user-ops`, through the production review path.
 *
 * Approval is what elevates `seed-user-rec-elev`: the service flips the tier and writes
 * `recruiter_verification.approved` in the same transaction, so the audit log says the account was
 * elevated by document review, which is what the seeded submission says happened. A submission
 * already decided by an earlier run is left alone; the end state is asserted afterwards either way.
 */
export const performOperatorReviews = async (sql: Sql, services: ReviewService): Promise<void> => {
  for (const review of OPERATOR_REVIEWS) {
    try {
      await services.reviewRecruiterVerification(
        OPERATOR_ACTOR_ID,
        review.submissionId,
        review.decision,
        review.reason,
      );
    } catch (error) {
      if (!isAlreadyReviewed(error)) {
        throw error;
      }
    }
  }

  await assertOperatorReviewsLanded(sql);
};

const isAlreadyReviewed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "recruiter_verification_already_reviewed";

/**
 * The end state, not the absence of an error. `elevated` gates full-institution creation and
 * competition publishing, so if the approval did not land, the rest of the matrix is silently
 * hollow rather than visibly broken.
 */
const assertOperatorReviewsLanded = async (sql: Sql): Promise<void> => {
  const [state] = await sql<{ tier: string; approved: string; rejected: string }[]>`
    SELECT
      (SELECT recruiter_verification_tier FROM users WHERE id = 'seed-user-rec-elev') AS tier,
      (SELECT status FROM recruiter_verification_submissions WHERE id = 'seed-rvs-elev') AS approved,
      (SELECT status FROM recruiter_verification_submissions WHERE id = 'seed-rvs-rej') AS rejected
  `;

  if (
    state?.tier !== "elevated" ||
    state.approved !== "approved" ||
    state.rejected !== "rejected"
  ) {
    throw new Error(
      `operator reviews did not land: seed-user-rec-elev is "${state?.tier}", seed-rvs-elev is ` +
        `"${state?.approved}", seed-rvs-rej is "${state?.rejected}". Expected elevated / approved / ` +
        "rejected.",
    );
  }
};
