import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  hostOrganizationEmails,
  hostTrustRemovals,
  users,
} from "@/server/db/schema";
import { organizationDomainOf } from "@/server/host-trust/email-domain";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-trust-watch-service");

export type HostTrustWatchEntry = {
  userId: string;
  name: string;
  signInEmail: string;
  organizationEmail: string;
  domain: string;
  trustedSince: Date;
  watchEndsAt: Date;
};

const WATCH_LENGTH_MS = 90 * 24 * 60 * 60 * 1000;

// The later of the Email organisasi confirm and the host step. No column holds the time an account
// became trusted, so this is the closest one, and a new confirm moves it.
const trustedSinceOf = () =>
  sql<Date>`greatest(${hostOrganizationEmails.confirmedAt}, ${users.recruiterVerifiedAt})`;

// The watched domain itself or a domain under it.
const onWatchedDomain = or(
  eq(hostOrganizationEmails.domain, hostTrustRemovals.organizationDomain),
  sql`${hostOrganizationEmails.domain} like ('%.' || ${hostTrustRemovals.organizationDomain})`,
)!;

// One row per removal in the window and account on its domain. The removed account, an untrusted,
// inactive or suspended account and a trust from before the removal never show.
const readWatchRows = (db: Database, watchStart: Date) =>
  db
    .select({
      userId: users.id,
      name: sql<string>`coalesce(${candidateProfiles.fullName}, ${users.username})`,
      signInEmail: users.email,
      organizationEmail: hostOrganizationEmails.email,
      organizationEmailDomain: hostOrganizationEmails.domain,
      watchedDomain: hostTrustRemovals.organizationDomain,
      removedAt: hostTrustRemovals.removedAt,
      trustedSince: trustedSinceOf().mapWith(hostOrganizationEmails.confirmedAt),
    })
    .from(hostTrustRemovals)
    .innerJoin(hostOrganizationEmails, onWatchedDomain)
    .innerJoin(users, eq(users.id, hostOrganizationEmails.userId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, users.id))
    .where(
      and(
        isNotNull(hostTrustRemovals.organizationDomain),
        gt(hostTrustRemovals.removedAt, watchStart),
        eq(users.recruiterVerificationTier, "elevated"),
        eq(users.status, "active"),
        isNull(users.suspendedAt),
        sql`${users.id} is distinct from ${hostTrustRemovals.userId}`,
        sql`${trustedSinceOf()} > ${hostTrustRemovals.removedAt}`,
      ),
    );

type WatchRow = Awaited<ReturnType<typeof readWatchRows>>[number];

// The join keeps the domain and every name under it. The organization domain of the address, read
// as the trust removal record reads it, decides.
const toEntryOnWatchedDomain = (row: WatchRow): HostTrustWatchEntry | null => {
  if (row.watchedDomain === null) return null;
  if (organizationDomainOf(row.organizationEmailDomain) !== row.watchedDomain) return null;
  return {
    userId: row.userId,
    name: row.name,
    signInEmail: row.signInEmail,
    organizationEmail: row.organizationEmail,
    domain: row.watchedDomain,
    trustedSince: row.trustedSince,
    watchEndsAt: new Date(row.removedAt.getTime() + WATCH_LENGTH_MS),
  };
};

// When two watches cover one account, the later one, so the row shows the last day it is watched.
const keepLatestWatchPerAccount = (entries: HostTrustWatchEntry[]): HostTrustWatchEntry[] => {
  const latestByAccount = new Map<string, HostTrustWatchEntry>();
  for (const entry of entries) {
    const kept = latestByAccount.get(entry.userId);
    if (kept === undefined || entry.watchEndsAt.getTime() > kept.watchEndsAt.getTime()) {
      latestByAccount.set(entry.userId, entry);
    }
  }
  return [...latestByAccount.values()];
};

const newestTrustFirst = (first: HostTrustWatchEntry, second: HostTrustWatchEntry): number =>
  second.trustedSince.getTime() - first.trustedSince.getTime() ||
  first.userId.localeCompare(second.userId);

// The staff watch of the 90 days after a trust removal on an organization domain. It only reads, so
// no trust waits on it, and the route's role gate is its access check.
export const listHostTrustWatch = async (
  db: Database = getDb(),
): Promise<HostTrustWatchEntry[]> => {
  const watchStart = new Date(Date.now() - WATCH_LENGTH_MS);
  const rows = await readWatchRows(db, watchStart);
  const entries = rows.flatMap((row) => {
    const entry = toEntryOnWatchedDomain(row);
    return entry === null ? [] : [entry];
  });
  return keepLatestWatchPerAccount(entries).sort(newestTrustFirst);
};
