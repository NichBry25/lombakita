import { ne } from "drizzle-orm";
import { serverEnv } from "@/config/env.server";
import { getDb, type Database } from "@/server/db/client";
import { hostTrustRemovals } from "@/server/db/schema";
import {
  HostIdentityKeyError,
  hostIdentityKeyCheck,
} from "@/server/host-trust/removed-host-identity";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-identity-key-probe");

export const isHostIdentityKeyConfigured = (): boolean => {
  return Boolean(serverEnv.hostIdentityHashKey);
};

// Once the key changes, the match refuses every host step that has a record to compare against. The
// deploy gate refuses that key here, before a build. The key is read first, so a missing or
// malformed key is refused even when no record exists yet.
export const assertTrustRemovalRecordsUseLiveKey = async (db: Database): Promise<void> => {
  const liveKeyCheck = hostIdentityKeyCheck();
  const [recordUnderAnotherKey] = await db
    .select({ id: hostTrustRemovals.id })
    .from(hostTrustRemovals)
    .where(ne(hostTrustRemovals.keyCheck, liveKeyCheck))
    .limit(1);
  if (recordUnderAnotherKey === undefined) return;
  throw new HostIdentityKeyError(
    "host_identity_key_changed",
    "A trust removal record was written under another HOST_IDENTITY_HASH_KEY",
  );
};

export const probeHostIdentityKey = async (): Promise<void> => {
  await assertTrustRemovalRecordsUseLiveKey(getDb());
};
