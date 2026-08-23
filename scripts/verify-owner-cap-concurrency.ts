/**
 * Real two-connection concurrency proof for the per-recruiter institution-count cap.
 * The unit suite no-ops `tx.execute`, so it can only assert lock-key
 * derivation and acquire-before-count ordering — it CANNOT prove that two genuinely concurrent
 * Postgres transactions serialize on the advisory lock. This script does: it drives the real
 * service functions (real `db.transaction()`, real `pg_advisory_xact_lock`) on a connection pool
 * wide enough that the two racers land on separate backends, then asserts exactly one succeeds,
 * the other gets the byte-identical 409, and the final owned-count never exceeds the cap.
 *
 * It runs against whatever DATABASE_URL resolves to. Pointed at local Postgres it proves the SQL
 * semantics; pointed at the Neon pooled (PgBouncer transaction-mode) connection string it also
 * proves the transaction-scoped lock releases on the same pinned backend.
 *
 * Seeds and cleans up its own users/institutions; leaves the database as it found it.
 *
 * Usage: node --import tsx scripts/verify-owner-cap-concurrency.ts
 * Exit code: 0 when every assertion holds; 1 on any cap breach or wrong-error.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

// Load .env.local, then force APP_ENV=test so the server db-client module's assertRuntimeEnv("web")
// short-circuits (it requires AUTH_SECRET etc. only outside test context). Must happen before any
// `@/`-aliased import, so all app imports below are dynamic.
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {
  // .env.local optional; rely on ambient env
}
process.env.APP_ENV = "test";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const ITERATIONS = 5;

const main = async (): Promise<void> => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const { createInstitutionWorkspaceForUser, createPersonalInstitutionForUser } =
    await import("@/server/institution-workspace/institution-service");

  // max:8 → each concurrent db.transaction() gets its own backend connection, so the two racers
  // truly run in parallel and contend on the advisory lock (not on a single shared connection).
  const client = postgres(databaseUrl, { max: 8, prepare: false });
  const db = drizzle(client, { schema });

  const createdUserIds: string[] = [];

  const seedRecruiter = async (): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    // candidate_verified_at satisfies users_one_verified_role_chk; recruiter_verified_at stays NULL
    // so users_recruiter_tier_consistency_chk holds at the default 'unverified' tier. Role/tier are
    // irrelevant to the cap (the count reads institution_memberships only; the tier gate lives in the
    // route layer, which this proof deliberately bypasses to test the service-layer cap directly).
    await client`
    INSERT INTO users (id, email, username, candidate_verified_at, email_verified)
    VALUES (${id}, ${`capconc_${tag}@example.test`}, ${`capconc_${tag}`}, now(), now())
  `;
    createdUserIds.push(id);
    return id;
  };

  const countOwned = async (userId: string, kind: "personal" | "full"): Promise<number> => {
    const typePredicate =
      kind === "personal"
        ? client`i.institution_type = 'personal'`
        : client`i.institution_type IS DISTINCT FROM 'personal'`;
    const rows = await client<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM institution_memberships m
    JOIN institutions i ON i.id = m.institution_id
    WHERE m.user_id = ${userId}
      AND m.membership_role = 'institution_owner'
      AND m.status = 'active'
      AND ${typePredicate}
  `;
    return rows[0]?.n ?? 0;
  };

  type Outcome = {
    ok: number;
    failCode: string | null;
    failStatus: number | null;
    other: string[];
  };

  const race = async (a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<Outcome> => {
    const results = await Promise.allSettled([a(), b()]);
    const outcome: Outcome = { ok: 0, failCode: null, failStatus: null, other: [] };
    for (const r of results) {
      if (r.status === "fulfilled") {
        outcome.ok += 1;
      } else {
        const reason = r.reason as { code?: string; httpStatus?: number; message?: string };
        if (reason && typeof reason.code === "string") {
          outcome.failCode = reason.code;
          outcome.failStatus = reason.httpStatus ?? null;
        } else {
          outcome.other.push(reason?.message ?? String(reason));
        }
      }
    }
    return outcome;
  };

  let failures = 0;
  const check = (cond: boolean, label: string) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures += 1;
  };

  const runPersonalSite = async () => {
    console.log(`\n[personal create] cap=1, ${ITERATIONS} iterations, two concurrent creates each`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedRecruiter();
      const outcome = await race(
        () => createPersonalInstitutionForUser(userId, db),
        () => createPersonalInstitutionForUser(userId, db),
      );
      const finalCount = await countOwned(userId, "personal");
      check(
        outcome.ok === 1 &&
          outcome.failCode === "personal_institution_already_exists" &&
          outcome.failStatus === 409 &&
          outcome.other.length === 0 &&
          finalCount === 1,
        `iter ${i}: ok=${outcome.ok} loser=${outcome.failCode}(${outcome.failStatus}) owned=${finalCount}` +
          ` [want: ok=1 loser=personal_institution_already_exists(409) owned=1]` +
          (outcome.other.length ? ` [unexpected: ${outcome.other.join("; ")}]` : ""),
      );
    }
  };

  const runFullSite = async () => {
    console.log(
      `\n[full create] cap=3, ${ITERATIONS} iterations, seed 2 then two concurrent creates`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedRecruiter();
      const createFull = (label: string) =>
        createInstitutionWorkspaceForUser(
          userId,
          {
            displayName: `Cap Conc Full ${label} ${i} ${userId.slice(0, 6)}`,
            institutionType: "company",
          },
          db,
        );
      await createFull("A");
      await createFull("B");
      // Distinct display names → distinct slugs, so the only thing that can stop a racer is the cap,
      // never a slug-uniqueness 23505.
      const outcome = await race(
        () => createFull("C"),
        () => createFull("D"),
      );
      const finalCount = await countOwned(userId, "full");
      check(
        outcome.ok === 1 &&
          outcome.failCode === "recruiter_institution_limit_reached" &&
          outcome.failStatus === 409 &&
          outcome.other.length === 0 &&
          finalCount === 3,
        `iter ${i}: ok=${outcome.ok} loser=${outcome.failCode}(${outcome.failStatus}) owned=${finalCount}` +
          ` [want: ok=1 loser=recruiter_institution_limit_reached(409) owned=3]` +
          (outcome.other.length ? ` [unexpected: ${outcome.other.join("; ")}]` : ""),
      );
    }
  };

  const runCrossOwner = async () => {
    console.log(
      `\n[cross-owner] two DIFFERENT owners create personal simultaneously — both must succeed`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const u1 = await seedRecruiter();
      const u2 = await seedRecruiter();
      const outcome = await race(
        () => createPersonalInstitutionForUser(u1, db),
        () => createPersonalInstitutionForUser(u2, db),
      );
      const c1 = await countOwned(u1, "personal");
      const c2 = await countOwned(u2, "personal");
      check(
        outcome.ok === 2 && outcome.failCode === null && c1 === 1 && c2 === 1,
        `iter ${i}: both succeed (ok=${outcome.ok}), each owns 1 (u1=${c1}, u2=${c2})`,
      );
    }
  };

  const cleanup = async () => {
    if (createdUserIds.length === 0) return;
    const instRows = await client<{ institution_id: string }[]>`
    SELECT DISTINCT institution_id FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)})
  `;
    const instIds = instRows.map((r) => r.institution_id);
    await client`DELETE FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)})`;
    if (instIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(instIds)})`;
    }
    await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    console.log(
      `\nCleaned up ${createdUserIds.length} seeded users and ${instIds.length} institutions.`,
    );
  };

  try {
    const iso = await client<
      { iso: string }[]
    >`SELECT current_setting('default_transaction_isolation') AS iso`;
    console.log(`DATABASE default_transaction_isolation = ${iso[0]?.iso ?? "unknown"}`);
    await runPersonalSite();
    await runFullSite();
    await runCrossOwner();
  } finally {
    await cleanup();
    await client.end();
  }

  console.log(
    `\n${failures === 0 ? "ALL CONCURRENCY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
