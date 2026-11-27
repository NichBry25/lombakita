import { createHmac } from "node:crypto";
import { and, arrayOverlaps, desc, eq, lte, or, sql, type SQL } from "drizzle-orm";
import { serverEnv } from "@/config/env.server";
import { toDialDigits } from "@/lib/competitions/organizer-contact";
import { normalizeEmail } from "@/server/auth/credentials-auth";
import type { Database } from "@/server/db/client";
import {
  candidateProfiles,
  hostOrganizationEmails,
  hostTrustRemovals,
  recruiterVerificationSubmissions,
  userProfiles,
  users,
} from "@/server/db/schema";
import {
  extractEmailDomain,
  isNeverOrganizationEmailDomain,
  organizationDomainOf,
} from "@/server/host-trust/email-domain";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/removed-host-identity");

// The record of a staff trust removal is kept as keyed hashes, so a new account holding the same
// email or phone goes to the host check. The hashes are pseudonymous: whoever holds the key can test
// a guess against them.

export type HostIdentityKeyErrorCode =
  | "host_identity_key_missing"
  | "host_identity_key_invalid"
  | "host_identity_key_changed";

export class HostIdentityKeyError extends Error {
  constructor(
    public readonly code: HostIdentityKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostIdentityKeyError";
  }
}

export type HostIdentifierKind = "email" | "phone";

export type HostIdentifiers = {
  emails: string[];
  phones: string[];
  organizationDomain: string | null;
};

export type RemovedHostMatch = { matchedBy: HostIdentifierKind[]; removedAt: Date };

type IdentifierHashes = { emailHashes: string[]; phoneHashes: string[] };

type MatchingRecord = { removedAt: Date; emailMatched: boolean; phoneMatched: boolean };

const HOST_IDENTITY_KEY_BYTES = 32;
const KEY_CHECK_LABEL = "host-identity-key-check";

// The match, the writer and the purge read this one window, so a record older than 2 years decides
// nothing whether or not the purge has run.
const RECORDS_KEPT_SINCE = sql`now() - interval '2 years'`;

// Read on every call, so a missing or malformed key fails the first hash and nothing stands in for it.
const readHostIdentityKey = (): Buffer => {
  const configured = serverEnv.hostIdentityHashKey;
  if (!configured) {
    throw new HostIdentityKeyError(
      "host_identity_key_missing",
      "HOST_IDENTITY_HASH_KEY is not configured",
    );
  }
  const key = Buffer.from(configured, "base64");
  if (key.length !== HOST_IDENTITY_KEY_BYTES) {
    throw new HostIdentityKeyError(
      "host_identity_key_invalid",
      `HOST_IDENTITY_HASH_KEY must decode to ${HOST_IDENTITY_KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
};

const hmacHex = (text: string): string => {
  const key = readHostIdentityKey();
  return createHmac("sha256", key).update(text).digest("hex");
};

// Two spellings of one inbox give one value: case, outer spaces and a plus tag in the local part go.
// Dots stay.
export const matchableEmail = (email: string): string => {
  const normalized = normalizeEmail(email);
  const plusIndex = normalized.indexOf("+");
  const atIndex = normalized.lastIndexOf("@");
  if (plusIndex <= 0 || atIndex < plusIndex) return normalized;
  return `${normalized.slice(0, plusIndex)}${normalized.slice(atIndex)}`;
};

// The value is already matchable: an address from matchableEmail, a phone as toDialDigits returns it.
export const hashHostIdentifier = (kind: HostIdentifierKind, value: string): string =>
  hmacHex(`${kind}:${value}`);

export const hostIdentityKeyCheck = (): string => hmacHex(KEY_CHECK_LABEL);

const readSignInEmail = async (db: Database, userId: string): Promise<string | null> => {
  const [account] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return account?.email ?? null;
};

const readOrganizationEmail = async (
  db: Database,
  userId: string,
): Promise<{ email: string; domain: string } | null> => {
  const [organizationEmail] = await db
    .select({ email: hostOrganizationEmails.email, domain: hostOrganizationEmails.domain })
    .from(hostOrganizationEmails)
    .where(eq(hostOrganizationEmails.userId, userId))
    .limit(1);
  return organizationEmail ?? null;
};

// A rejected or unreviewed host request may carry another person's number, so only approved ones
// count.
const readGivenPhones = async (db: Database, userId: string): Promise<string[]> => {
  const signUpPhones = await db
    .select({ phone: candidateProfiles.phoneNumber })
    .from(candidateProfiles)
    .where(eq(candidateProfiles.userId, userId));
  const profilePhones = await db
    .select({ phone: userProfiles.phoneNumber })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
  const approvedRequestPhones = await db
    .select({ phone: recruiterVerificationSubmissions.mobileNumber })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "approved"),
      ),
    );
  const rows = [...signUpPhones, ...profilePhones, ...approvedRequestPhones];
  return rows.flatMap((row) => (row.phone === null ? [] : [row.phone]));
};

const dialDigitsOf = (phones: string[]): string[] =>
  phones.flatMap((phone) => {
    const digits = toDialDigits(phone);
    return digits === null ? [] : [digits];
  });

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

// The Email organisasi names the organization. Without one the sign-in email does, unless no
// organization can hold its domain.
const organizationDomainFor = (
  signInEmail: string | null,
  organizationEmailDomain: string | null,
): string | null => {
  if (organizationEmailDomain !== null) return organizationDomainOf(organizationEmailDomain);
  if (signInEmail === null) return null;
  const signInDomain = extractEmailDomain(normalizeEmail(signInEmail));
  if (signInDomain === null || isNeverOrganizationEmailDomain(signInDomain)) return null;
  return organizationDomainOf(signInDomain);
};

// The one list the record stores and the match compares: the emails the person proved and the
// phones they gave as their own. A legacy corporate email or a challenge address was only typed, so
// neither counts.
export const readHostIdentifiers = async (
  db: Database,
  userId: string,
): Promise<HostIdentifiers> => {
  const signInEmail = await readSignInEmail(db, userId);
  const organizationEmail = await readOrganizationEmail(db, userId);
  const givenPhones = await readGivenPhones(db, userId);
  const emails: string[] = [];
  if (signInEmail !== null) emails.push(matchableEmail(signInEmail));
  if (organizationEmail !== null) emails.push(matchableEmail(organizationEmail.email));
  return {
    emails: sortedUnique(emails),
    phones: sortedUnique(dialDigitsOf(givenPhones)),
    organizationDomain: organizationDomainFor(signInEmail, organizationEmail?.domain ?? null),
  };
};

const hashIdentifiers = (identifiers: HostIdentifiers): IdentifierHashes => ({
  emailHashes: identifiers.emails.map((email) => hashHostIdentifier("email", email)),
  phoneHashes: identifiers.phones.map((phone) => hashHostIdentifier("phone", phone)),
});

const holdsRemovalWithinKeepWindow = async (tx: Database, userId: string): Promise<boolean> => {
  const [account] = await tx
    .select({
      holdsKeptRemoval: sql<boolean>`coalesce(${users.hostTrustRemovedAt} > ${RECORDS_KEPT_SINCE}, false)`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return account?.holdsKeptRemoval ?? false;
};

// Copied in SQL, so the record keeps the removal time to the microsecond and never the time of this
// write.
const removalTimeOf = (userId: string): SQL =>
  sql`(select ${users.hostTrustRemovedAt} from ${users} where ${users.id} = ${userId})`;

// One record per account: the hashes it held and the ones it holds now, each once, and the first
// domain it had. The update runs only under the key the record was written with.
const upsertRemovalRecord = (tx: Database, userId: string, identifiers: HostIdentifiers) => {
  const hashes = hashIdentifiers(identifiers);
  return tx
    .insert(hostTrustRemovals)
    .values({
      userId,
      removedAt: removalTimeOf(userId),
      organizationDomain: identifiers.organizationDomain,
      emailHashes: hashes.emailHashes,
      phoneHashes: hashes.phoneHashes,
      keyCheck: hostIdentityKeyCheck(),
    })
    .onConflictDoUpdate({
      target: hostTrustRemovals.userId,
      targetWhere: sql`${hostTrustRemovals.userId} is not null`,
      set: {
        removedAt: sql`excluded.removed_at`,
        organizationDomain: sql`coalesce(${hostTrustRemovals.organizationDomain}, excluded.organization_domain)`,
        emailHashes: sql`array(select distinct hash from unnest(${hostTrustRemovals.emailHashes} || excluded.email_hashes) as hash order by hash)`,
        phoneHashes: sql`array(select distinct hash from unnest(${hostTrustRemovals.phoneHashes} || excluded.phone_hashes) as hash order by hash)`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${hostTrustRemovals.keyCheck} = excluded.key_check`,
    })
    .returning({ id: hostTrustRemovals.id });
};

// Writes the record of the account's removal, or adds what the account holds now to the record it
// has. Writes nothing for an account with no removal in the last 2 years.
export const recordRemovedHostIdentity = async (tx: Database, userId: string): Promise<boolean> => {
  const holdsKeptRemoval = await holdsRemovalWithinKeepWindow(tx, userId);
  if (!holdsKeptRemoval) return false;

  const identifiers = await readHostIdentifiers(tx, userId);
  const written = await upsertRemovalRecord(tx, userId, identifiers);
  if (written.length === 0) {
    throw new HostIdentityKeyError(
      "host_identity_key_changed",
      "The account's trust removal record was written under another HOST_IDENTITY_HASH_KEY",
    );
  }
  return true;
};

// Records of other accounts whose removal is within the last 2 years. An account never matches its
// own record.
const otherAccountsKeptRecords = (userId: string): SQL =>
  and(
    sql`${hostTrustRemovals.userId} is distinct from ${userId}`,
    sql`${hostTrustRemovals.removedAt} > ${RECORDS_KEPT_SINCE}`,
  )!;

const readOtherAccountsKeyChecks = async (db: Database, userId: string): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ keyCheck: hostTrustRemovals.keyCheck })
    .from(hostTrustRemovals)
    .where(otherAccountsKeptRecords(userId));
  return rows.map((row) => row.keyCheck);
};

// Hashes under another key match nothing, so a changed key is refused instead of read as no match.
const assertRecordsUseLiveKey = (keyChecks: string[]): void => {
  const liveKeyCheck = hostIdentityKeyCheck();
  if (keyChecks.every((keyCheck) => keyCheck === liveKeyCheck)) return;
  throw new HostIdentityKeyError(
    "host_identity_key_changed",
    "A trust removal record was written under another HOST_IDENTITY_HASH_KEY",
  );
};

const readNewestMatchingRecord = async (
  db: Database,
  userId: string,
  hashes: IdentifierHashes,
): Promise<MatchingRecord | null> => {
  // arrayOverlaps refuses an empty list, and an account may hold no phone, or no email, to match by.
  const emailOverlap =
    hashes.emailHashes.length === 0
      ? sql`false`
      : arrayOverlaps(hostTrustRemovals.emailHashes, hashes.emailHashes);
  const phoneOverlap =
    hashes.phoneHashes.length === 0
      ? sql`false`
      : arrayOverlaps(hostTrustRemovals.phoneHashes, hashes.phoneHashes);
  const [record] = await db
    .select({
      removedAt: hostTrustRemovals.removedAt,
      emailMatched: sql<boolean>`${emailOverlap}`,
      phoneMatched: sql<boolean>`${phoneOverlap}`,
    })
    .from(hostTrustRemovals)
    .where(and(otherAccountsKeptRecords(userId), or(emailOverlap, phoneOverlap)))
    .orderBy(desc(hostTrustRemovals.removedAt))
    .limit(1);
  return record ?? null;
};

const matchedByOf = (record: MatchingRecord): HostIdentifierKind[] => {
  const matchedBy: HostIdentifierKind[] = [];
  if (record.emailMatched) matchedBy.push("email");
  if (record.phoneMatched) matchedBy.push("phone");
  return matchedBy;
};

// Whether another account removed in the last 2 years shares a proven email or a given phone with
// this one, read against the newest such removal. With no such record it answers without the key, so
// an environment with no removal needs none.
export const findRemovedHostMatch = async (
  db: Database,
  userId: string,
): Promise<RemovedHostMatch | null> => {
  const keyChecks = await readOtherAccountsKeyChecks(db, userId);
  if (keyChecks.length === 0) return null;
  assertRecordsUseLiveKey(keyChecks);

  const identifiers = await readHostIdentifiers(db, userId);
  const hashes = hashIdentifiers(identifiers);
  const record = await readNewestMatchingRecord(db, userId, hashes);
  if (record === null) return null;
  return { matchedBy: matchedByOf(record), removedAt: record.removedAt };
};

export const liftRemovedHostRecord = async (tx: Database, userId: string): Promise<void> => {
  await tx.delete(hostTrustRemovals).where(eq(hostTrustRemovals.userId, userId));
};

// The boundary is the match window's own, so a record is either matched or purged, never both.
export const purgeExpiredHostTrustRemovals = async (db: Database): Promise<number> => {
  const purged = await db
    .delete(hostTrustRemovals)
    .where(lte(hostTrustRemovals.removedAt, RECORDS_KEPT_SINCE))
    .returning({ id: hostTrustRemovals.id });
  return purged.length;
};
