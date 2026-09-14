/**
 * Opt-in entry point for the operator accounts and the operator acts on the testing matrix.
 *
 * NOT part of `npm run db:reset`. This creates the highest-privilege accounts the application has,
 * which no product path can create, in a repository that is public. So it is a command someone
 * runs on purpose, after the matrix seed, on a database the guard below has confirmed is
 * disposable. What it writes and why is in `seed/operator-accounts.ts`.
 *
 * Usage: npm run db:seed:operators   (after `npm run db:reset` or `npm run db:seed`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  OPERATOR_ACCOUNTS,
  OPERATOR_SECRETS_FILE,
  enrolOperatorFactors,
  performOperatorReviews,
  seedOperatorAccountRows,
} from "./seed/operator-accounts";
import { SEED_PASSWORD, hashSeedPassword } from "./seed/seed-credentials";
import { assertSeedTargetIsDisposable, resolveSeedDatabaseUrl } from "./seed/seed-target";

const databaseUrl = resolveSeedDatabaseUrl(
  "This script creates platform_ops and finance_ops accounts, the highest privilege the " +
    "application has and one no product path can grant, with a published password. Anywhere " +
    "reachable from outside this machine, that is an open operator login.",
);

/** Loaded after the environment is read; see the note in `seed-test-matrix.ts`. */
const loadApplicationServices = async () => {
  const [factorService, totp, base32, review, dbClient, queue, r2] = await Promise.all([
    import("@/server/auth/mfa/factor-service"),
    import("@/server/auth/mfa/totp"),
    import("@/server/auth/mfa/base32"),
    import("@/server/recruiter-verification/recruiter-verification-service"),
    import("@/server/db/client"),
    import("@/server/async/queue"),
    import("@/server/storage/r2.client"),
  ]);

  return {
    startMfaEnrolment: factorService.startMfaEnrolment,
    confirmMfaEnrolment: factorService.confirmMfaEnrolment,
    generateTotpCode: totp.generateTotpCode,
    base32Decode: base32.base32Decode,
    reviewRecruiterVerification: review.reviewRecruiterVerification,
    closeDbConnection: dbClient.closeDbConnection,
    closeAsyncQueueConnections: queue.closeAsyncQueueConnections,
    isR2Available: r2.isR2Available,
  };
};

/**
 * Says out loud which object store the reviews below will reach.
 *
 * A review sweeps the submission's own R2 prefix post-commit, deleting objects no row references.
 * NO GUARD LAYER SEES R2: the disposability check reads the database's identity and the
 * environment, and the deploy gate declares no canonical bucket per environment to compare
 * `R2_BUCKET` against, so nothing here can refuse a production bucket in a local `.env.local`. Until
 * that identity exists (LAUNCH-D71), the honest thing is to name the target at every run rather
 * than sweep it silently.
 */
const discloseObjectStoreReach = (isR2Available: () => boolean): void => {
  if (!isR2Available()) {
    console.log("  object store: not configured; the post-review sweep is a no-op");
    return;
  }

  console.log(
    `  object store: bucket "${process.env.R2_BUCKET}" at ${process.env.R2_ENDPOINT}. The ` +
      "post-review sweep WILL reach it, and no guard checks which bucket that is",
  );
};

const assertMatrixSeedHasRun = async (sql: import("postgres").Sql): Promise<void> => {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM recruiter_verification_submissions WHERE id LIKE 'seed-rvs-%'
  `;

  if (!row || row.n === 0) {
    throw new Error(
      "the testing matrix has not been seeded: no seed-rvs-% submissions exist for an operator to " +
        "review. Run `npm run db:reset` (or `npm run db:seed`) first.",
    );
  }
};

const main = async (): Promise<void> => {
  const { default: postgres } = await import("postgres");
  const services = await loadApplicationServices();
  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await assertSeedTargetIsDisposable(sql, databaseUrl);
    console.log("  target is disposable; seeding operator accounts");

    discloseObjectStoreReach(services.isR2Available);
    await assertMatrixSeedHasRun(sql);

    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await seedOperatorAccountRows(sql, await hashSeedPassword(), hundredDaysAgo);
    console.log(`  ✓ ${OPERATOR_ACCOUNTS.length} operator accounts written`);

    const secrets = await enrolOperatorFactors(services);
    console.log(`  ✓ ${Object.keys(secrets).length} factors enrolled through the production path`);

    await performOperatorReviews(sql, services);
    console.log("  ✓ seed-rvs-elev approved (elevating seed-user-rec-elev), seed-rvs-rej rejected");

    mkdirSync(dirname(OPERATOR_SECRETS_FILE), { recursive: true });
    writeFileSync(OPERATOR_SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`);

    console.log(`\nOperator accounts use password: ${SEED_PASSWORD}`);
    console.log(`Second factors for this run are in ${OPERATOR_SECRETS_FILE} (git-ignored).`);
    console.log("Add an authenticator entry from the otpauthUri, or let the testing lane read the file.");
  } finally {
    await sql.end();
    // The production services run against the application's own pooled connection rather than
    // this script's, and a rejection enqueues its notice on the BullMQ producer connection, so the
    // process would otherwise sit on two open sockets after finishing.
    await services.closeDbConnection();
    await services.closeAsyncQueueConnections();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
