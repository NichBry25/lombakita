import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const ACCOUNT_LOCK_NAMESPACE = "org_email_send_account:";
const EMAIL_LOCK_NAMESPACE = "org_email_send_email:";

// Serializes the Email organisasi sends of one account and of one address for the life of tx, so the
// daily counts taken after these locks see every earlier committed send. The account key is always
// taken first and the address key second, so two sends never wait on each other in opposite orders.
// Transaction-scoped for the pooling reason given at acquireOwnerCapLock.
export const acquireOrganizationEmailSendLocks = async (
  tx: TransactionClient,
  userId: string,
  email: string,
): Promise<void> => {
  const accountLockKey = `${ACCOUNT_LOCK_NAMESPACE}${userId}`;
  const emailLockKey = `${EMAIL_LOCK_NAMESPACE}${email}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${accountLockKey}))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${emailLockKey}))`);
};
