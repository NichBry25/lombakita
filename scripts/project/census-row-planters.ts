//
// The rows that plant one tie to a user on each foreign key into `users`, and the fixture graph they
// hang from. Extracted unchanged from `deletion-census-oracle.integration.test.ts` so the promotion
// leftover oracle can plant the same rows: two oracles planting the same edges two different ways
// would be two answers to one question.
//
// Nothing here connects to a database. Every function takes the transaction handle it is given.

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/** One planted row, and how to find it again after the delete. */
export type Planted = {
  table: string;
  /** The primary key columns, and their values on the row that was planted. */
  identity: Record<string, string>;
};

/** One probe: the row to plant, which edges it exercises, and how it is found again. */
export type Probe = {
  /** Every edge this planted row is evidence for. Two CASCADE edges out of one row share it. */
  keys: string[];
  /** The name used in a failure message. */
  name: string;
  plant: (sql: Sql, fx: Fixture) => Promise<Planted>;
};

export type Sql = postgres.Sql<Record<string, never>>;

/** The rows every probe builds on: two users, an institution, a competition, two teams, a fee rule. */
export type Fixture = {
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
// The fixture graph.
// ---------------------------------------------------------------------------------------------

export const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

export const buildFixture = async (sql: Sql): Promise<Fixture> => {
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

export const ALL_PROBES: Probe[] = [
  ...userOwnedProbes,
  ...graphProbes,
  ...institutionProbes,
  ...recruiterProbes,
  ...platformOpsProbes,
  ...financeProbes,
];
