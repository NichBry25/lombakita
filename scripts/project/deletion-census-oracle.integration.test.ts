// @vitest-environment node
//
// WHAT A DELETION ACTUALLY DOES, measured against a live Postgres, constraint by constraint.
//
// WHY THIS EXISTS (LAUNCH-D105). The census used to decide whether a foreign key blocks or detaches
// by looking at the SOURCE TABLE's membership in the CASCADE closure. Postgres does not: it applies
// the action per ROW. A table can be inside the closure and still hold a row that survives, and it
// can be inside the closure and hold a row that refuses the whole statement. `platform_ops_notes`
// is both cases in one table — a note ABOUT the deleted user cascades away, and a note the deleted
// operator WROTE blocks the delete outright. No amount of reading the schema module settles which
// of those is true; only the database does.
//
// So this suite stops reading and starts deleting. It enumerates every foreign key from
// `pg_constraint` in the live catalog, plants a row on each edge whose source row nothing else
// removes, deletes a user it created itself, and records what happened as exactly one of
// `refused`, `nulled` or `removed`. Then it asserts the census's two lists equal what it observed.
//
// IT SHARES NO DERIVATION WITH THE CENSUS. The edge list comes from `pg_constraint`, the closure
// this file walks is computed from that catalog read, and the expected side is an OBSERVATION
// rather than a computation. The census is imported for the actual side only, which is the point:
// two independent derivations agreeing is evidence, one derivation checking itself is not.
//
// EVERYTHING ROLLS BACK. The fixture and every probe run inside one transaction that is rolled back
// at the end, and the suite counts every affected table before and after and asserts the counts are
// equal — so a probe that somehow committed is a failing test rather than a dirty dev database.
//
// NOTHING HERE TOUCHES A NON-LOCAL HOST. The connection string is refused unless its host is
// loopback, before a single byte is sent.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { isLocalDatabaseHost, parseDatabaseHost } from "../lib/local-database-host";
import { blockingForeignKeys, detachingForeignKeys } from "./deletion-census";

const DATABASE_URL = TEST_DATABASE_URL;

/** What the database did to the planted row when the subject was deleted. */
type Outcome = "refused" | "nulled" | "removed" | "survived";

/** One foreign key, as the live catalog describes it. */
type CatalogEdge = {
  constraint: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  /** `confdeltype`: `a` NO ACTION, `r` RESTRICT, `c` CASCADE, `n` SET NULL, `d` SET DEFAULT. */
  onDelete: string;
};

/** The catalog's spelling of an edge, used to key probes and to name a missing one. */
const edgeKeyOf = (edge: CatalogEdge): string =>
  `${edge.sourceTable}.${edge.sourceColumns.join("+")}`;

/** One planted row, and how to find it again after the delete. */
type Planted = {
  table: string;
  /** The primary key columns, and their values on the row that was planted. */
  identity: Record<string, string>;
};

/** One probe: the row to plant, which edges it exercises, and how it is found again. */
type Probe = {
  /** Every edge this planted row is evidence for. Two CASCADE edges out of one row share it. */
  keys: string[];
  /** The name used in a failure message. */
  name: string;
  plant: (sql: Sql, fx: Fixture) => Promise<Planted>;
};

type Sql = postgres.Sql<Record<string, never>>;

/** The rows every probe builds on: two users, an institution, a competition, two teams, a fee rule. */
type Fixture = {
  subject: string;
  bystander: string;
  institution: string;
  /** A second institution, so a probe can add a membership without colliding with the fixture's. */
  spareInstitution: string;
  competition: string;
  feeRule: string;
  subjectRegistration: string;
  bystanderRegistration: string;
  subjectTeam: string;
  bystanderTeam: string;
  subjectMembership: string;
};

// ---------------------------------------------------------------------------------------------
// Catalog reads. Independent of `deletion-census.ts` by construction.
// ---------------------------------------------------------------------------------------------

const readCatalogEdges = async (sql: Sql): Promise<CatalogEdge[]> => {
  const rows = await sql<
    {
      constraint: string;
      source_table: string;
      source_columns: string[];
      target_table: string;
      target_columns: string[];
      on_delete: string;
    }[]
  >`
    select
      con.conname as constraint,
      src.relname as source_table,
      (select array_agg(att.attname order by k.ord)
         from unnest(con.conkey) with ordinality as k(attnum, ord)
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) as source_columns,
      tgt.relname as target_table,
      (select array_agg(att.attname order by k.ord)
         from unnest(con.confkey) with ordinality as k(attnum, ord)
         join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum
      ) as target_columns,
      con.confdeltype as on_delete
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    where con.contype = 'f'
      and con.connamespace = 'public'::regnamespace
    order by src.relname, con.conname`;

  return rows.map((row) => ({
    constraint: row.constraint,
    sourceTable: row.source_table,
    sourceColumns: row.source_columns,
    targetTable: row.target_table,
    targetColumns: row.target_columns,
    onDelete: row.on_delete,
  }));
};

/** The CASCADE closure from `users`, walked over the catalog's own edges. */
const closureFromCatalog = (edges: readonly CatalogEdge[], from = "users"): Set<string> => {
  const reached = new Set<string>([from]);

  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of edges) {
      if (edge.onDelete !== "c") continue;
      if (!reached.has(edge.targetTable) || reached.has(edge.sourceTable)) continue;
      reached.add(edge.sourceTable);
      grew = true;
    }
  }

  return reached;
};

/** Every base table in `public`, for the before-and-after residue count. */
const publicTables = async (sql: Sql): Promise<string[]> => {
  const rows = await sql<{ table: string }[]>`
    select c.relname as table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`;

  return rows.map((row) => row.table);
};

const countEveryTable = async (
  sql: Sql,
  tables: readonly string[],
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();

  for (const table of tables) {
    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from ${sql(table)}`;
    counts.set(table, Number(row?.count ?? "0"));
  }

  return counts;
};

const differingTables = (
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): string[] =>
  [...before]
    .filter(([table, count]) => after.get(table) !== count)
    .map(([table, count]) => `${table}: ${count} -> ${after.get(table)}`);

// ---------------------------------------------------------------------------------------------
// The fixture graph.
// ---------------------------------------------------------------------------------------------

const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const buildFixture = async (sql: Sql): Promise<Fixture> => {
  const subject = randomUUID();
  const bystander = randomUUID();
  const institution = randomUUID();
  const spareInstitution = randomUUID();
  const competition = randomUUID();
  const feeRule = randomUUID();
  const subjectRegistration = randomUUID();
  const bystanderRegistration = randomUUID();
  const subjectTeam = randomUUID();
  const bystanderTeam = randomUUID();
  const subjectMembership = randomUUID();

  await sql`insert into users (id, email, username, candidate_verified_at)
    values (${subject}, ${`oracle-subject-${subject}@example.test`}, ${`oracle_subject_${subject.slice(0, 8)}`}, now()),
           (${bystander}, ${`oracle-bystander-${bystander}@example.test`}, ${`oracle_bystander_${bystander.slice(0, 8)}`}, now())`;

  await sql`insert into institutions (id, slug, institution_type, display_name, status)
    values (${institution}, ${`oracle-inst-${institution.slice(0, 8)}`}, 'company', 'Oracle Fixture Institution', 'active'),
           (${spareInstitution}, ${`oracle-spare-${spareInstitution.slice(0, 8)}`}, 'company', 'Oracle Spare Institution', 'active')`;

  await sql`insert into institution_memberships (id, institution_id, user_id, membership_role, status)
    values (${subjectMembership}, ${institution}, ${subject}, 'institution_owner', 'active'),
           (${randomUUID()}, ${institution}, ${bystander}, 'institution_staff', 'active')`;

  await sql`insert into finance_fee_rules (id, institution_id, basis_points, flat_amount, currency, effective_from)
    values (${feeRule}, ${institution}, 0, 0, 'IDR', now())`;

  await sql`insert into competitions (id, institution_id, slug, title, status)
    values (${competition}, ${institution}, ${`oracle-comp-${competition.slice(0, 8)}`}, 'Oracle Fixture Competition', 'draft')`;

  await sql`insert into competition_registrations (id, competition_id, student_id, registration_type, status)
    values (${subjectRegistration}, ${competition}, ${subject}, 'individual', 'confirmed'),
           (${bystanderRegistration}, ${competition}, ${bystander}, 'individual', 'confirmed')`;

  await sql`insert into teams (id, competition_id, name, captain_id, status)
    values (${subjectTeam}, ${competition}, 'Oracle Subject Team', ${subject}, 'forming'),
           (${bystanderTeam}, ${competition}, 'Oracle Bystander Team', ${bystander}, 'forming')`;

  return {
    subject,
    bystander,
    institution,
    spareInstitution,
    competition,
    feeRule,
    subjectRegistration,
    bystanderRegistration,
    subjectTeam,
    bystanderTeam,
    subjectMembership,
  };
};

/** A payment on the fixture competition, with the named payer and registration. */
const insertPayment = async (
  sql: Sql,
  fx: Fixture,
  payerUserId: string,
  registrationId: string | null,
): Promise<string> => {
  const id = randomUUID();

  await sql`insert into finance_payments (
      id, payer_user_id, receiving_institution_id, competition_registration_id, subject_type,
      currency, gross_amount, fee_rule_id, fee_basis_points, fee_flat_amount,
      platform_fee_amount, institution_net_amount, origin
    ) values (
      ${id}, ${payerUserId}, ${fx.institution}, ${registrationId}, 'competition_registration',
      'IDR', 100000, ${fx.feeRule}, 0, 0, 0, 100000, 'gateway'
    )`;

  return id;
};

const insertProof = async (
  sql: Sql,
  fx: Fixture,
  paymentId: string,
  submittedBy: string,
  reviewer: string,
): Promise<string> => {
  const id = randomUUID();

  await sql`insert into finance_manual_payment_proofs (
      id, payment_id, competition_id, submitted_by_user_id, reviewer_user_id, status,
      r2_key, original_file_name, file_size_bytes, content_type
    ) values (
      ${id}, ${paymentId}, ${fx.competition}, ${submittedBy}, ${reviewer}, 'pending_review',
      ${`payment-proofs/${fx.competition}/${paymentId}/oracle.jpg`}, 'oracle.jpg', 1024, 'image/jpeg'
    )`;

  return id;
};

/** A recruiter verification submission, so `recruiter_verification_documents` has a parent. */
const insertRecruiterSubmission = async (sql: Sql, userId: string): Promise<string> => {
  const id = randomUUID();

  await sql`insert into recruiter_verification_submissions (id, user_id, full_name, mobile_number, status)
    values (${id}, ${userId}, 'Oracle Fixture Recruiter', '+628000000000', 'draft')`;

  return id;
};

const insertDocumentRequest = async (
  sql: Sql,
  fx: Fixture,
  registrationId: string,
  requestedBy: string | null,
  reviewedBy: string | null,
): Promise<string> => {
  const id = randomUUID();

  await sql`insert into competition_document_requests (
      id, registration_id, title, due_at, status, requested_by_user_id, reviewed_by_user_id
    ) values (
      ${id}, ${registrationId}, 'Oracle Fixture Document', ${EXPIRES_AT}, 'requested',
      ${requestedBy}, ${reviewedBy}
    )`;

  return id;
};

// ---------------------------------------------------------------------------------------------
// The probes. One per edge, and two edges share a probe where one planted row is genuinely
// evidence for both — the composite team key is the case, and it is reported as shared rather
// than dressed up as two independent observations.
// ---------------------------------------------------------------------------------------------

const probe = (keys: string[], plant: (sql: Sql, fx: Fixture) => Promise<Planted>): Probe => ({
  keys,
  name: keys.join(" | "),
  plant,
});

/** How a probe's row is found again after the delete, given the id it was inserted with. */
type IdentityFn = (id: string, row: Record<string, unknown>) => Record<string, string>;

/**
 * A probe on a table whose only edge into the population is a plain `user_id` column. Sixteen
 * tables have exactly that shape and the same expected outcome, so they share one builder rather
 * than sixteen near-identical plant functions.
 */
const userColumnProbe = (
  table: string,
  build: (fx: Fixture, id: string) => Record<string, unknown>,
  identity: IdentityFn = (id) => ({ id }),
): Probe =>
  probe([`${table}.user_id`], async (sql, fx) => {
    const id = randomUUID();
    const row = build(fx, id);
    await sql`insert into ${sql(table)} ${sql(row)}`;
    return { table, identity: identity(id, row) };
  });

const userOwnedProbes: Probe[] = [
  userColumnProbe(
    "accounts",
    (fx, id) => ({
      user_id: fx.subject,
      type: "oauth",
      provider: "oracle",
      provider_account_id: id,
    }),
    (id) => ({ provider_account_id: id }),
  ),
  userColumnProbe(
    "candidate_profiles",
    (fx) => ({
      user_id: fx.subject,
      full_name: "Oracle Subject",
      phone_number: "+628000000001",
      occupation: "other",
      date_of_birth: "1990-01-01",
    }),
    (_id, row) => ({ user_id: String(row.user_id) }),
  ),
  userColumnProbe(
    "competition_saves",
    (fx) => ({ user_id: fx.subject, competition_id: fx.competition }),
    (_id, row) => ({ user_id: String(row.user_id), competition_id: String(row.competition_id) }),
  ),
  userColumnProbe("mfa_factors", (fx) => ({
    user_id: fx.subject,
    encrypted_secret: "oracle-secret",
    secret_iv: "oracle-iv",
    secret_auth_tag: "oracle-tag",
  })),
  userColumnProbe("mfa_recovery_codes", (fx) => ({
    user_id: fx.subject,
    code_hash: "oracle-code-hash",
  })),
  userColumnProbe("notifications", (fx) => ({
    user_id: fx.subject,
    type: "oracle_notification",
    title: "Oracle Fixture Notification",
    body: "Created by the deletion census oracle and rolled back with it.",
  })),
  userColumnProbe("profile_certifications", (fx) => ({
    user_id: fx.subject,
    name: "Oracle Fixture Certification",
    issuer: "Oracle Fixture Issuer",
  })),
  userColumnProbe("profile_educations", (fx) => ({
    user_id: fx.subject,
    school: "Oracle Fixture School",
  })),
  userColumnProbe("profile_experiences", (fx) => ({
    user_id: fx.subject,
    title: "Oracle Fixture Title",
    organization_name: "Oracle Fixture Organisation",
  })),
  userColumnProbe("profile_skills", (fx) => ({
    user_id: fx.subject,
    name: "Oracle Fixture Skill",
  })),
  userColumnProbe("profile_social_links", (fx) => ({
    user_id: fx.subject,
    platform: "website",
    url: "https://example.test/oracle",
  })),
  userColumnProbe(
    "sessions",
    (fx, id) => ({
      session_token: `oracle-session-${id}`,
      user_id: fx.subject,
      expires: EXPIRES_AT,
    }),
    (id) => ({ session_token: `oracle-session-${id}` }),
  ),
  userColumnProbe("user_email_verification_tokens", (fx) => ({
    user_id: fx.subject,
    token_hash: "oracle-token-hash",
    expires_at: EXPIRES_AT,
  })),
  userColumnProbe(
    "user_password_credentials",
    (fx) => ({ user_id: fx.subject, password_hash: "oracle-password-hash" }),
    (_id, row) => ({ user_id: String(row.user_id) }),
  ),
  userColumnProbe(
    "user_platform_roles",
    (fx) => ({ user_id: fx.subject, role: "candidate" }),
    (_id, row) => ({ user_id: String(row.user_id), role: String(row.role) }),
  ),
  userColumnProbe(
    "user_profiles",
    (fx) => ({ user_id: fx.subject }),
    (_id, row) => ({
      user_id: String(row.user_id),
    }),
  ),
];

const graphProbes: Probe[] = [
  probe(["teams.captain_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into teams (id, competition_id, name, captain_id, status)
      values (${id}, ${fx.competition}, 'Oracle Probe Team', ${fx.subject}, 'forming')`;
    return { table: "teams", identity: { id } };
  }),
  probe(["team_memberships.team_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into team_memberships (id, team_id, user_id, role, status)
      values (${id}, ${fx.subjectTeam}, ${fx.bystander}, 'member', 'active')`;
    return { table: "team_memberships", identity: { id } };
  }),
  probe(["team_memberships.user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into team_memberships (id, team_id, user_id, role, status)
      values (${id}, ${fx.bystanderTeam}, ${fx.subject}, 'member', 'active')`;
    return { table: "team_memberships", identity: { id } };
  }),
  probe(["team_invitations.team_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into team_invitations (id, team_id, invited_email, token_hash, expires_at)
      values (${id}, ${fx.subjectTeam}, 'oracle-invite@example.test', 'oracle-hash', ${EXPIRES_AT})`;
    return { table: "team_invitations", identity: { id } };
  }),
  probe(["team_invitations.invited_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into team_invitations (id, team_id, invited_email, token_hash, expires_at, invited_by_user_id)
      values (${id}, ${fx.bystanderTeam}, 'oracle-invite@example.test', 'oracle-hash', ${EXPIRES_AT}, ${fx.subject})`;
    return { table: "team_invitations", identity: { id } };
  }),
  probe(["team_invitations.target_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into team_invitations (id, team_id, invited_email, token_hash, expires_at, invited_by_user_id, target_user_id)
      values (${id}, ${fx.bystanderTeam}, 'oracle-invite@example.test', 'oracle-hash', ${EXPIRES_AT}, ${fx.bystander}, ${fx.subject})`;
    return { table: "team_invitations", identity: { id } };
  }),
  probe(["competition_registrations.student_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competition_registrations (id, competition_id, student_id, registration_type, status)
      values (${id}, ${fx.competition}, ${fx.subject}, 'individual', 'cancelled')`;
    return { table: "competition_registrations", identity: { id } };
  }),
  // ONE ROW, TWO CONSTRAINTS, AND THEY CANNOT BE SEPARATED. `team_id` and the composite
  // `(competition_id, team_id)` both reference the same team row, both CASCADE, and both fire on
  // that one row's removal — so a single plant is the only honest evidence for either. Which
  // constraint removed the row is not observable here, and the report says so rather than counting
  // this as two independent confirmations.
  probe(
    ["competition_registrations.team_id", "competition_registrations.competition_id+team_id"],
    async (sql, fx) => {
      const id = randomUUID();
      await sql`insert into competition_registrations (id, competition_id, student_id, registration_type, team_id, status)
        values (${id}, ${fx.competition}, ${fx.bystander}, 'team', ${fx.subjectTeam}, 'cancelled')`;
      return { table: "competition_registrations", identity: { id } };
    },
  ),
  probe(["competition_document_requests.registration_id"], async (sql, fx) => {
    const id = await insertDocumentRequest(sql, fx, fx.subjectRegistration, null, null);
    return { table: "competition_document_requests", identity: { id } };
  }),
  probe(["competition_document_requests.requested_by_user_id"], async (sql, fx) => {
    const id = await insertDocumentRequest(sql, fx, fx.bystanderRegistration, fx.subject, null);
    return { table: "competition_document_requests", identity: { id } };
  }),
  probe(["competition_document_requests.reviewed_by_user_id"], async (sql, fx) => {
    const id = await insertDocumentRequest(
      sql,
      fx,
      fx.bystanderRegistration,
      fx.bystander,
      fx.subject,
    );
    return { table: "competition_document_requests", identity: { id } };
  }),
  probe(["competition_document_request_files.request_id"], async (sql, fx) => {
    const request = await insertDocumentRequest(sql, fx, fx.subjectRegistration, null, null);
    const id = randomUUID();
    await sql`insert into competition_document_request_files (id, request_id, r2_key, original_file_name, file_size_bytes, content_type)
      values (${id}, ${request}, 'document-requests/oracle.pdf', 'oracle.pdf', 1024, 'application/pdf')`;
    return { table: "competition_document_request_files", identity: { id } };
  }),
  probe(["competition_results.registration_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competition_results (id, registration_id, competition_id, result_status)
      values (${id}, ${fx.subjectRegistration}, ${fx.competition}, 'draft')`;
    return { table: "competition_results", identity: { id } };
  }),
  probe(["competition_reviews.author_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competition_reviews (id, competition_id, author_user_id, rating, status)
      values (${id}, ${fx.competition}, ${fx.subject}, 3, 'visible')`;
    return { table: "competition_reviews", identity: { id } };
  }),
  probe(["competition_submissions.registration_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competition_submissions (id, registration_id, submitted_by_id, file_key, file_name)
      values (${id}, ${fx.subjectRegistration}, ${fx.bystander}, 'submissions/oracle.pdf', 'oracle.pdf')`;
    return { table: "competition_submissions", identity: { id } };
  }),
  probe(["competition_submissions.submitted_by_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competition_submissions (id, registration_id, submitted_by_id, file_key, file_name)
      values (${id}, ${fx.bystanderRegistration}, ${fx.subject}, 'submissions/oracle.pdf', 'oracle.pdf')`;
    return { table: "competition_submissions", identity: { id } };
  }),
  probe(["competitions.created_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into competitions (id, institution_id, slug, title, status, created_by_user_id)
      values (${id}, ${fx.institution}, ${`oracle-created-${id.slice(0, 8)}`}, 'Oracle Created Competition', 'draft', ${fx.subject})`;
    return { table: "competitions", identity: { id } };
  }),
];

const institutionProbes: Probe[] = [
  probe(["institution_memberships.user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_memberships (id, institution_id, user_id, membership_role, status)
      values (${id}, ${fx.spareInstitution}, ${fx.subject}, 'institution_staff', 'active')`;
    return { table: "institution_memberships", identity: { id } };
  }),
  probe(["institution_memberships.invited_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_memberships (id, institution_id, user_id, membership_role, status, invited_by_user_id)
      values (${id}, ${fx.spareInstitution}, ${fx.bystander}, 'institution_member', 'active', ${fx.subject})`;
    return { table: "institution_memberships", identity: { id } };
  }),
  probe(["institution_invitations.invited_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_invitations (id, institution_id, invited_email, invited_role, token_hash, expires_at, invited_by_user_id)
      values (${id}, ${fx.institution}, 'oracle-invite@example.test', 'institution_staff', 'oracle-hash', ${EXPIRES_AT}, ${fx.subject})`;
    return { table: "institution_invitations", identity: { id } };
  }),
  probe(["institution_invitations.target_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_invitations (id, institution_id, invited_email, invited_role, token_hash, expires_at, invited_by_user_id, target_user_id)
      values (${id}, ${fx.institution}, 'oracle-invite@example.test', 'institution_staff', 'oracle-hash', ${EXPIRES_AT}, ${fx.bystander}, ${fx.subject})`;
    return { table: "institution_invitations", identity: { id } };
  }),
  probe(["institution_audit_logs.actor_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_audit_logs (id, institution_id, action, actor_user_id)
      values (${id}, ${fx.institution}, 'oracle.fixture', ${fx.subject})`;
    return { table: "institution_audit_logs", identity: { id } };
  }),
  probe(["institution_audit_logs.target_membership_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_audit_logs (id, institution_id, action, actor_user_id, target_membership_id)
      values (${id}, ${fx.institution}, 'oracle.fixture', ${fx.bystander}, ${fx.subjectMembership})`;
    return { table: "institution_audit_logs", identity: { id } };
  }),
  probe(["institution_verification_audit.actor_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_verification_audit (id, institution_id, from_status, to_status, actor_user_id)
      values (${id}, ${fx.institution}, 'pending_verification', 'under_review', ${fx.subject})`;
    return { table: "institution_verification_audit", identity: { id } };
  }),
  probe(["institution_verification_submissions.submitted_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_verification_submissions (id, institution_id, target_institution_type, submitted_by_user_id)
      values (${id}, ${fx.institution}, 'company', ${fx.subject})`;
    return { table: "institution_verification_submissions", identity: { id } };
  }),
  probe(["institution_verification_submissions.reviewer_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into institution_verification_submissions (id, institution_id, target_institution_type, submitted_by_user_id, reviewer_user_id)
      values (${id}, ${fx.institution}, 'company', ${fx.bystander}, ${fx.subject})`;
    return { table: "institution_verification_submissions", identity: { id } };
  }),
];

const recruiterProbes: Probe[] = [
  probe(["recruiter_verification_submissions.user_id"], async (sql, fx) => {
    const id = await insertRecruiterSubmission(sql, fx.subject);
    return { table: "recruiter_verification_submissions", identity: { id } };
  }),
  probe(["recruiter_verification_submissions.reviewer_user_id"], async (sql, fx) => {
    const id = await insertRecruiterSubmission(sql, fx.bystander);
    await sql`update recruiter_verification_submissions set reviewer_user_id = ${fx.subject} where id = ${id}`;
    return { table: "recruiter_verification_submissions", identity: { id } };
  }),
  probe(["recruiter_verification_documents.submission_id"], async (sql, fx) => {
    const submission = await insertRecruiterSubmission(sql, fx.subject);
    const id = randomUUID();
    await sql`insert into recruiter_verification_documents (id, submission_id, r2_key, original_file_name, file_size_bytes, content_type)
      values (${id}, ${submission}, 'recruiter-verification/oracle.pdf', 'oracle.pdf', 1024, 'application/pdf')`;
    return { table: "recruiter_verification_documents", identity: { id } };
  }),
];

const platformOpsProbes: Probe[] = [
  probe(["platform_ops_audit_logs.actor_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into platform_ops_audit_logs (id, actor_user_id, event_type, target_institution_id)
      values (${id}, ${fx.subject}, 'oracle.fixture', ${fx.institution})`;
    return { table: "platform_ops_audit_logs", identity: { id } };
  }),
  probe(["platform_ops_audit_logs.target_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into platform_ops_audit_logs (id, actor_user_id, event_type, target_user_id)
      values (${id}, ${fx.bystander}, 'oracle.fixture', ${fx.subject})`;
    return { table: "platform_ops_audit_logs", identity: { id } };
  }),
  probe(["platform_ops_notes.created_by_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into platform_ops_notes (id, note, created_by_id, target_institution_id)
      values (${id}, 'Oracle fixture note.', ${fx.subject}, ${fx.institution})`;
    return { table: "platform_ops_notes", identity: { id } };
  }),
  probe(["platform_ops_notes.target_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into platform_ops_notes (id, note, created_by_id, target_user_id)
      values (${id}, 'Oracle fixture note.', ${fx.bystander}, ${fx.subject})`;
    return { table: "platform_ops_notes", identity: { id } };
  }),
];

const financeProbes: Probe[] = [
  probe(["finance_payments.payer_user_id"], async (sql, fx) => {
    const id = await insertPayment(sql, fx, fx.subject, fx.bystanderRegistration);
    return { table: "finance_payments", identity: { id } };
  }),
  probe(["finance_payments.competition_registration_id"], async (sql, fx) => {
    const id = await insertPayment(sql, fx, fx.bystander, fx.subjectRegistration);
    return { table: "finance_payments", identity: { id } };
  }),
  probe(["finance_payment_events.actor_user_id"], async (sql, fx) => {
    const payment = await insertPayment(sql, fx, fx.bystander, fx.bystanderRegistration);
    const id = randomUUID();
    await sql`insert into finance_payment_events (id, payment_id, event_type, occurred_at, actor_type, actor_user_id, idempotency_key)
      values (${id}, ${payment}, 'initiated', now(), 'user', ${fx.subject}, ${`oracle-${id}`})`;
    return { table: "finance_payment_events", identity: { id } };
  }),
  probe(["finance_fee_disclosure_acknowledgements.acknowledged_by_user_id"], async (sql, fx) => {
    const id = randomUUID();
    await sql`insert into finance_fee_disclosure_acknowledgements (
        id, competition_id, institution_id, acknowledged_by_user_id, fee_rule_id,
        fee_basis_points, fee_flat_amount, fee_amount, fee_currency
      ) values (
        ${id}, ${fx.competition}, ${fx.institution}, ${fx.subject}, ${fx.feeRule}, 0, 0, 100000, 'IDR'
      )`;
    return { table: "finance_fee_disclosure_acknowledgements", identity: { id } };
  }),
  probe(["finance_manual_payment_proofs.submitted_by_user_id"], async (sql, fx) => {
    const payment = await insertPayment(sql, fx, fx.bystander, fx.bystanderRegistration);
    const id = await insertProof(sql, fx, payment, fx.subject, fx.bystander);
    return { table: "finance_manual_payment_proofs", identity: { id } };
  }),
  probe(["finance_manual_payment_proofs.reviewer_user_id"], async (sql, fx) => {
    const payment = await insertPayment(sql, fx, fx.bystander, fx.bystanderRegistration);
    const id = await insertProof(sql, fx, payment, fx.bystander, fx.subject);
    return { table: "finance_manual_payment_proofs", identity: { id } };
  }),
  probe(["finance_manual_payment_proof_attempts.submitted_by_user_id"], async (sql, fx) => {
    const payment = await insertPayment(sql, fx, fx.bystander, fx.bystanderRegistration);
    const proof = await insertProof(sql, fx, payment, fx.bystander, fx.bystander);
    const id = randomUUID();
    await sql`insert into finance_manual_payment_proof_attempts (
        id, proof_id, payment_id, competition_id, attempt_number, submitted_by_user_id, reviewer_user_id,
        r2_key, original_file_name, file_size_bytes, content_type, submitted_at, verdict, reviewed_at
      ) values (
        ${id}, ${proof}, ${payment}, ${fx.competition}, 1, ${fx.subject}, ${fx.bystander},
        'payment-proofs/oracle.jpg', 'oracle.jpg', 1024, 'image/jpeg', now(), 'verified', now()
      )`;
    return { table: "finance_manual_payment_proof_attempts", identity: { id } };
  }),
  probe(["finance_manual_payment_proof_attempts.reviewer_user_id"], async (sql, fx) => {
    const payment = await insertPayment(sql, fx, fx.bystander, fx.bystanderRegistration);
    const proof = await insertProof(sql, fx, payment, fx.bystander, fx.bystander);
    const id = randomUUID();
    await sql`insert into finance_manual_payment_proof_attempts (
        id, proof_id, payment_id, competition_id, attempt_number, submitted_by_user_id, reviewer_user_id,
        r2_key, original_file_name, file_size_bytes, content_type, submitted_at, verdict, reviewed_at
      ) values (
        ${id}, ${proof}, ${payment}, ${fx.competition}, 1, ${fx.bystander}, ${fx.subject},
        'payment-proofs/oracle.jpg', 'oracle.jpg', 1024, 'image/jpeg', now(), 'verified', now()
      )`;
    return { table: "finance_manual_payment_proof_attempts", identity: { id } };
  }),
];

const ALL_PROBES: Probe[] = [
  ...userOwnedProbes,
  ...graphProbes,
  ...institutionProbes,
  ...recruiterProbes,
  ...platformOpsProbes,
  ...financeProbes,
];

// ---------------------------------------------------------------------------------------------
// Running the probes.
// ---------------------------------------------------------------------------------------------

/** Thrown to force `sql.begin` to roll back; caught immediately after. */
class OracleRollback extends Error {}

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "23503";

const findPlantedRow = async (
  sql: Sql,
  planted: Planted,
): Promise<Record<string, unknown> | null> => {
  const conditions = Object.entries(planted.identity).map(
    ([column, value]) => sql`${sql(column)} = ${value}`,
  );
  const where = conditions.reduce((left, right) => sql`${left} and ${right}`);

  const rows = await sql`select * from ${sql(planted.table)} where ${where} limit 1`;

  return (rows[0] as Record<string, unknown> | undefined) ?? null;
};

/**
 * What happened to the planted row.
 *
 * `removed` and `nulled` are read off the row's own state, and they are different findings: a
 * removed row is gone, a nulled row is still in the table with its pointer to the deleted user
 * erased. `survived` means the row is still there AND still holds a non-null value in a column
 * constrained by this key — which can only happen if the delete did not actually enforce the
 * constraint, so it is treated as a blocking edge and will disagree with the census loudly.
 */
const observePlantedRow = async (
  sql: Sql,
  planted: Planted,
  constrainedColumns: readonly string[],
): Promise<Outcome> => {
  const row = await findPlantedRow(sql, planted);

  if (row === null) {
    return "removed";
  }

  const stillPointsAtTheDeletedUser = constrainedColumns.some(
    (column) => row[column] !== null && row[column] !== undefined,
  );

  return stillPointsAtTheDeletedUser ? "survived" : "nulled";
};

/**
 * Deletes the subject with one probe's row planted, and reports what happened to that row.
 *
 * Two savepoints, and both are load-bearing. The inner one exists because a 23503 ABORTS the
 * transaction: without rolling back to a marker taken before the delete, every later probe in this
 * run would fail with "current transaction is aborted" rather than with its own result. The outer
 * one discards the probe's own planted row, so probes cannot contaminate each other.
 */
const runProbe = async (
  sql: Sql,
  probeUnderTest: Probe,
  fx: Fixture,
  edgesByKey: ReadonlyMap<string, CatalogEdge>,
): Promise<Map<string, Outcome>> => {
  const constrainedColumns = [
    ...new Set(probeUnderTest.keys.flatMap((key) => edgesByKey.get(key)?.sourceColumns ?? [])),
  ];

  const observed = new Map<string, Outcome>();

  await sql.unsafe("savepoint census_probe");
  try {
    const planted = await probeUnderTest.plant(sql, fx);

    await sql.unsafe("savepoint census_delete");
    try {
      await sql`delete from users where id = ${fx.subject}`;
      await sql.unsafe("release savepoint census_delete");
      observed.set(probeUnderTest.name, await observePlantedRow(sql, planted, constrainedColumns));
    } catch (error) {
      await sql.unsafe("rollback to savepoint census_delete");
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      observed.set(probeUnderTest.name, "refused");
    }
  } finally {
    await sql.unsafe("rollback to savepoint census_probe");
  }

  const outcome = observed.get(probeUnderTest.name) as Outcome;

  return new Map(probeUnderTest.keys.map((key) => [key, outcome]));
};

type EdgeObservation = {
  key: string;
  constraint: string;
  sourceTable: string;
  sourceColumns: readonly string[];
  targetTable: string;
  targetColumns: readonly string[];
  onDelete: string;
  outcome: Outcome;
  /** True when one planted row is the only evidence for more than one constraint. */
  sharedPlant: boolean;
};

type OracleRun = {
  observations: EdgeObservation[];
  blocking: string[];
  detaching: string[];
  /** Tables whose row count changed across the whole run. Empty means the run left nothing. */
  residue: string[];
};

const runOracle = async (sql: Sql): Promise<OracleRun> => {
  const edges = await readCatalogEdges(sql);
  const closure = closureFromCatalog(edges);
  const population = edges.filter((edge) => closure.has(edge.targetTable));
  const edgesByKey = new Map(population.map((edge) => [edgeKeyOf(edge), edge]));

  const probedKeys = ALL_PROBES.flatMap((entry) => entry.keys);

  const unprobed = population.map(edgeKeyOf).filter((key) => !probedKeys.includes(key));
  if (unprobed.length > 0) {
    throw new Error(
      `no probe plants a row on ${unprobed.length} of the ${population.length} edges, so their ` +
        `outcome would be assumed rather than measured: ${unprobed.join(", ")}`,
    );
  }

  const phantom = probedKeys.filter((key) => !edgesByKey.has(key));
  if (phantom.length > 0) {
    throw new Error(
      `a probe claims an edge the live catalog does not have, so it is planting against a ` +
        `constraint that does not exist: ${phantom.join(", ")}`,
    );
  }

  const tables = await publicTables(sql);
  const before = await countEveryTable(sql, tables);

  const outcomes = new Map<string, Outcome>();

  await sql
    .begin(async (rawTx) => {
      // postgres.js types `TransactionSql` as an `Omit<Sql>`, which drops the call signature even
      // though the value is callable. The cast is the type system's, not the runtime's: this is a
      // real sql function bound to the transaction's connection.
      const tx = rawTx as unknown as Sql;
      const fx = await buildFixture(tx);

      for (const entry of ALL_PROBES) {
        const results = await runProbe(tx, entry, fx, edgesByKey);
        for (const [key, outcome] of results) {
          outcomes.set(key, outcome);
        }
      }

      throw new OracleRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof OracleRollback)) {
        throw error;
      }
    });

  const after = await countEveryTable(sql, tables);

  const observations = population.map((edge) => {
    const key = edgeKeyOf(edge);

    return {
      key,
      constraint: edge.constraint,
      sourceTable: edge.sourceTable,
      sourceColumns: edge.sourceColumns,
      targetTable: edge.targetTable,
      targetColumns: edge.targetColumns,
      onDelete: edge.onDelete,
      outcome: outcomes.get(key) as Outcome,
      sharedPlant: ALL_PROBES.some((entry) => entry.keys.includes(key) && entry.keys.length > 1),
    };
  });

  for (const observation of observations) {
    if (observation.outcome === undefined) {
      throw new Error(`edge ${observation.key} was enumerated but never observed`);
    }
  }

  return {
    observations,
    // A key blocks a deletion when the delete refuses outright, or when a row is still holding a
    // value in a column this key constrains. The second case is the one the old table-wise rule
    // could not see, and it is why this list is measured rather than derived.
    blocking: observations
      .filter((o) => o.outcome === "refused" || o.outcome === "survived")
      .map((o) => o.key)
      .sort(),
    detaching: observations
      .filter((o) => o.outcome === "nulled")
      .map((o) => o.key)
      .sort(),
    residue: differingTables(before, after),
  };
};

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

afterAll(async () => {
  await client?.end();
});

let oracleRun: Promise<OracleRun> | null = null;

/**
 * The oracle's result, computed once for the whole file.
 *
 * It runs the entire deletion sequence inside one transaction, so every test in this suite reads
 * one measurement rather than re-running the deletes — and the transaction is rolled back by the
 * run itself, which is what makes the residue count meaningful.
 */
const oracle = (): Promise<OracleRun> => {
  if (oracleRun === null) {
    if (!DATABASE_URL) {
      throw new Error("the deletion oracle needs a database; this suite should have skipped");
    }
    if (!isLocalDatabaseHost(DATABASE_URL)) {
      throw new Error(
        `refusing to run the deletion oracle against ${parseDatabaseHost(DATABASE_URL) ?? "an unparseable host"}: ` +
          "it deletes users, and it may only do that on a loopback database",
      );
    }
    oracleRun = runOracle(client as unknown as Sql);
  }

  return oracleRun;
};

// ---------------------------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------------------------

const censusKey = (key: { sourceTable: string; sourceColumns: readonly string[] }): string =>
  `${key.sourceTable}.${key.sourceColumns.join("+")}`;

const censusBlocking = blockingForeignKeys().map(censusKey).sort();
const censusDetaching = detachingForeignKeys().map(censusKey).sort();

describe.skipIf(skipWithoutDatabase)("the deletion census oracle", () => {
  it("exercises every foreign key the closure reaches, and leaves no edge unmeasured", async () => {
    const run = await oracle();

    // A floor derived from the census rather than invented: set equality below would pass on two
    // empty lists, so the run has to be shown to have covered at least what the census claims.
    expect(run.observations.length).toBeGreaterThanOrEqual(
      censusBlocking.length + censusDetaching.length,
    );

    for (const observation of run.observations) {
      expect(observation.outcome, `${observation.key} has no observed outcome`).toBeDefined();
    }
  });

  it("leaves nothing behind: every table holds the same rows after the run as before it", async () => {
    const run = await oracle();

    expect(run.residue).toEqual([]);
  });

  it("never observes a row surviving the delete still pointing at the deleted user", async () => {
    const run = await oracle();

    expect(run.observations.filter((o) => o.outcome === "survived").map((o) => o.key)).toEqual([]);
  });

  it("agrees with the census on which keys block a deletion", async () => {
    const run = await oracle();

    expect(run.blocking).toEqual(censusBlocking);
  });

  it("agrees with the census on which keys detach instead of blocking", async () => {
    const run = await oracle();

    expect(run.detaching).toEqual(censusDetaching);
  });

  it("names the three edges the table-wise rule got wrong", async () => {
    const run = await oracle();
    const outcomeOf = (key: string) => run.observations.find((o) => o.key === key)?.outcome;

    // A note the deleted operator WROTE is not a note about them, so nothing cascades it and the
    // delete is refused outright. The table-wise rule called `platform_ops_notes` a table whose
    // rows cannot outlive the deletion, which is true of one of its two edges and false here.
    expect(outcomeOf("platform_ops_notes.created_by_id")).toBe("refused");

    // Both team_invitations pointers are SET NULL, but the source table is inside the CASCADE
    // closure (through its team), so the table-wise rule returned the whole table as removed and
    // never looked at either edge.
    expect(outcomeOf("team_invitations.target_user_id")).toBe("nulled");
    expect(outcomeOf("team_invitations.invited_by_user_id")).toBe("nulled");
  });

  it("reports the one pair of edges a single planted row is evidence for", async () => {
    const run = await oracle();
    const shared = run.observations
      .filter((o) => o.sharedPlant)
      .map((o) => o.constraint)
      .sort();

    // `team_id` and `(competition_id, team_id)` both reference the same team row, both CASCADE, and
    // both fire on that row's removal, so no planting can tell them apart. Both are reported; this
    // says out loud that the second confirmation is not independent.
    expect(shared).toEqual([
      "competition_registrations_competition_team_fk",
      "competition_registrations_team_id_teams_id_fk",
    ]);
  });

  it("prints the full edge table when asked for it", async () => {
    const run = await oracle();

    if (process.env.CENSUS_ORACLE_TABLE !== "1") {
      return;
    }

    const rows = run.observations.map(
      (o) =>
        `${o.constraint} | ${o.sourceTable}.${o.sourceColumns.join("+")} -> ` +
        `${o.targetTable}.${o.targetColumns.join("+")} | ON DELETE ${o.onDelete} | ${o.outcome}`,
    );

    console.log(`\n${run.observations.length} edges\n${rows.join("\n")}\n`);
  });
});
