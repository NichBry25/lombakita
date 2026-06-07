// One-shot integration harness for Step 4.4 manual test items.
// Bypasses HTTP/auth layer and exercises team-registration-service.ts +
// team-service.ts + competition-access.ts directly against the local DB,
// then asserts on DB state. Self-cleans on exit.
//
// Run with: node --import tsx src/server/scripts/test-step-4.4-manual.ts

import { existsSync } from "node:fs";

const loadLocalEnvFiles = (): void => {
  const candidates = [".env.local", ".env"];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
  }
};

type CheckResult = { id: string; description: string; status: "PASS" | "FAIL"; detail?: string };
const results: CheckResult[] = [];

const record = (id: string, description: string, status: "PASS" | "FAIL", detail?: string) => {
  results.push({ id, description, status, detail });
  const tag = status === "PASS" ? "✓" : "✗";
  console.log(`${tag} [${id}] ${description}${detail ? ` — ${detail}` : ""}`);
};

const expectError = async (
  id: string,
  description: string,
  expectedCode: string,
  fn: () => Promise<unknown>,
): Promise<void> => {
  try {
    await fn();
    record(id, description, "FAIL", `expected ${expectedCode}, got success`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === expectedCode) {
      record(id, description, "PASS", `rejected with ${expectedCode}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      record(id, description, "FAIL", `expected ${expectedCode}, got ${code ?? "(no code)"}: ${msg}`);
    }
  }
};

const expectOk = async (
  id: string,
  description: string,
  fn: () => Promise<unknown>,
): Promise<void> => {
  try {
    await fn();
    record(id, description, "PASS");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(id, description, "FAIL", `unexpected error: ${msg}`);
  }
};

const expectTrue = (id: string, description: string, condition: boolean, detail?: string) => {
  record(id, description, condition ? "PASS" : "FAIL", detail);
};

const pgCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (e as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return undefined;
};

const run = async (): Promise<void> => {
  loadLocalEnvFiles();
  process.env.RUNTIME_NAME = process.env.RUNTIME_NAME ?? "web";

  const { assertRuntimeEnv, resolveServerRuntime } = await import("@/config/env.server");
  assertRuntimeEnv(resolveServerRuntime(process.env.RUNTIME_NAME));

  const { getDb, closeDbConnection } = await import("@/server/db/client");
  const schema = await import("@/server/db/schema");
  const teamService = await import("@/server/teams/team-service");
  const teamRegService = await import("@/server/teams/team-registration-service");
  const compAccess = await import("@/server/competitions/competition-access");
  const regService = await import("@/server/registrations/registration-service");
  const { eq, and, inArray } = await import("drizzle-orm");

  const db = getDb();

  const SUFFIX = `step44-${Date.now()}`;
  const TAG = `__test_${SUFFIX}__`;

  // Seed identifiers
  const institutionId = `${TAG}_inst`;
  const ownerUserId = `${TAG}_owner`;
  const captainId = `${TAG}_captain`;
  const memberEligibleId = `${TAG}_m_elig`;
  const memberEligible2Id = `${TAG}_m_elig2`;
  const memberIncompleteId = `${TAG}_m_inc`;
  const outsiderId = `${TAG}_outsider`;
  const soloId = `${TAG}_solo`;
  const compTeamNormalId = `${TAG}_c_normal`;
  const compIndividualId = `${TAG}_c_indiv`;
  const compTeamMin3Id = `${TAG}_c_min3`;
  const compWindowFutureId = `${TAG}_c_window_future`;
  const compWindowPastId = `${TAG}_c_window_past`;

  const NOW = new Date();
  const PAST_2D = new Date(Date.now() - 2 * 86_400_000);
  const PAST_1H = new Date(Date.now() - 3_600_000);
  const FUTURE_30D = new Date(Date.now() + 30 * 86_400_000);
  const FUTURE_60D = new Date(Date.now() + 60 * 86_400_000);

  const cleanup = async () => {
    try {
      await db.delete(schema.users).where(
        inArray(schema.users.id, [
          ownerUserId,
          captainId,
          memberEligibleId,
          memberEligible2Id,
          memberIncompleteId,
          outsiderId,
          soloId,
        ]),
      );
      await db.delete(schema.competitions).where(
        inArray(schema.competitions.id, [
          compTeamNormalId,
          compIndividualId,
          compTeamMin3Id,
          compWindowFutureId,
          compWindowPastId,
        ]),
      );
      await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
    } catch (err) {
      console.error("cleanup error (non-fatal):", err);
    }
  };

  try {
    console.log("\n=== Seeding test data ===");

    await db.insert(schema.institutions).values({
      id: institutionId,
      displayName: `Institution ${SUFFIX}`,
      slug: `inst-${SUFFIX}`.toLowerCase(),
      status: "active",
      verificationStatus: "verified",
      verifiedAt: NOW,
    });

    const userRows = [
      { id: ownerUserId, username: `owner_${SUFFIX}`, email: `owner-${SUFFIX}@test.local` },
      { id: captainId, username: `cap_${SUFFIX}`, email: `cap-${SUFFIX}@test.local` },
      { id: memberEligibleId, username: `m1_${SUFFIX}`, email: `m1-${SUFFIX}@test.local` },
      { id: memberEligible2Id, username: `m2_${SUFFIX}`, email: `m2-${SUFFIX}@test.local` },
      { id: memberIncompleteId, username: `mi_${SUFFIX}`, email: `mi-${SUFFIX}@test.local` },
      { id: outsiderId, username: `out_${SUFFIX}`, email: `out-${SUFFIX}@test.local` },
      { id: soloId, username: `solo_${SUFFIX}`, email: `solo-${SUFFIX}@test.local` },
    ];

    for (const u of userRows) {
      await db.insert(schema.users).values({
        id: u.id,
        username: u.username,
        email: u.email,
        name: u.username,
        role: "candidate",
        status: "active",
        candidateVerifiedAt: NOW,
      });
    }

    // Eligibility profiles. All eligible except memberIncomplete (date_of_birth left null).
    // Age 22, enrolled, S1 — well within 18–32 inclusive range.
    const eligibleProfile = {
      dateOfBirth: "2003-01-15",
      enrollmentStatus: "enrolled" as const,
      educationLevel: "S1" as const,
      universityName: "Universitas Test",
      studentIdNumber: "12345",
    };

    for (const uid of [captainId, memberEligibleId, memberEligible2Id, outsiderId, soloId]) {
      await db.insert(schema.studentEligibilityProfiles).values({
        userId: uid,
        ...eligibleProfile,
      });
    }
    // Incomplete profile — missing date_of_birth
    await db.insert(schema.studentEligibilityProfiles).values({
      userId: memberIncompleteId,
      enrollmentStatus: "enrolled",
      educationLevel: "S1",
      universityName: "Universitas Test",
      studentIdNumber: "67890",
    });

    const baseCompetition = {
      institutionId,
      createdByUserId: ownerUserId,
      description: "Test competition",
      status: "published" as const,
      category: "technology" as const,
      registrationStartAt: PAST_2D,
      registrationEndAt: FUTURE_30D,
      eventStartAt: FUTURE_30D,
      eventEndAt: FUTURE_60D,
      publishedAt: NOW,
    };

    await db.insert(schema.competitions).values([
      {
        ...baseCompetition,
        id: compTeamNormalId,
        slug: `c-normal-${SUFFIX}`.toLowerCase(),
        title: `Normal Team Comp ${SUFFIX}`,
        mode: "team",
        minTeamSize: 2,
        maxTeamSize: 4,
      },
      {
        ...baseCompetition,
        id: compIndividualId,
        slug: `c-indiv-${SUFFIX}`.toLowerCase(),
        title: `Individual Comp ${SUFFIX}`,
        mode: "individual",
      },
      {
        ...baseCompetition,
        id: compTeamMin3Id,
        slug: `c-min3-${SUFFIX}`.toLowerCase(),
        title: `Min3 Comp ${SUFFIX}`,
        mode: "team",
        minTeamSize: 3,
        maxTeamSize: 5,
      },
      {
        ...baseCompetition,
        id: compWindowFutureId,
        slug: `c-wfut-${SUFFIX}`.toLowerCase(),
        title: `Window-Future Comp ${SUFFIX}`,
        mode: "team",
        minTeamSize: 1,
        maxTeamSize: 4,
        registrationStartAt: FUTURE_30D, // not yet open
        registrationEndAt: FUTURE_60D,
      },
      {
        ...baseCompetition,
        id: compWindowPastId,
        slug: `c-wpast-${SUFFIX}`.toLowerCase(),
        title: `Window-Past Comp ${SUFFIX}`,
        mode: "team",
        minTeamSize: 1,
        maxTeamSize: 4,
        registrationStartAt: PAST_2D,
        registrationEndAt: PAST_1H, // closed
      },
    ]);

    console.log("\n=== Schema-layer CHECK constraint assertions ===");

    // The DB CHECK should reject type='team' AND team_id IS NULL
    await expectError(
      "CHK-1",
      "DB rejects team-type row with null team_id (CHECK 23514)",
      "23514",
      async () => {
        try {
          await db.insert(schema.competitionRegistrations).values({
            competitionId: compTeamNormalId,
            studentId: captainId,
            registrationType: "team",
            status: "confirmed",
            teamId: null,
          });
        } catch (err) {
          const c = pgCode(err);
          throw Object.assign(new Error(String(err)), { code: c });
        }
      },
    );

    // Create a Tim Uji team on C-TEAM-NORMAL for use in the next assertions
    const timUji = await teamService.createTeam(
      captainId,
      compTeamNormalId,
      { name: `Tim Uji ${SUFFIX}` },
      db,
      NOW,
    );

    // Manually add eligible member to roster (skipping the email-token flow)
    await db.insert(schema.teamMemberships).values({
      teamId: timUji.id,
      userId: memberEligibleId,
      role: "member",
      status: "active",
      joinedAt: NOW,
    });

    // Now CHECK should reject type='individual' AND team_id non-null
    await expectError(
      "CHK-2",
      "DB rejects individual-type row with non-null team_id (CHECK 23514)",
      "23514",
      async () => {
        try {
          await db.insert(schema.competitionRegistrations).values({
            competitionId: compTeamNormalId,
            studentId: outsiderId,
            registrationType: "individual",
            status: "confirmed",
            teamId: timUji.id,
          });
        } catch (err) {
          const c = pgCode(err);
          throw Object.assign(new Error(String(err)), { code: c });
        }
      },
    );

    console.log("\n=== Service-layer gate assertions ===");

    // Item 2: team of 1 against C-TEAM-MIN3 (minTeamSize=3)
    // Build a 1-person team on C-TEAM-MIN3 for the captain
    const teamMin3 = await teamService.createTeam(
      captainId,
      compTeamMin3Id,
      { name: `Solo Captain Team ${SUFFIX}` },
      db,
      NOW,
    );
    await expectError(
      "M2",
      "Team below minTeamSize rejected at submission",
      "team_size_insufficient",
      () => teamRegService.submitTeamRegistration(captainId, compTeamMin3Id, teamMin3.id, db, NOW),
    );

    // Item 3: team of 5 against C-TEAM-NORMAL (maxTeamSize=4)
    // Manually grow Tim Uji to 5 active members (captain + 4) by adding 3 more directly
    await db.insert(schema.teamMemberships).values([
      {
        teamId: timUji.id,
        userId: memberEligible2Id,
        role: "member",
        status: "active",
        joinedAt: NOW,
      },
      {
        teamId: timUji.id,
        userId: memberIncompleteId,
        role: "member",
        status: "active",
        joinedAt: NOW,
      },
      {
        teamId: timUji.id,
        userId: outsiderId,
        role: "member",
        status: "active",
        joinedAt: NOW,
      },
    ]);
    // Tim Uji now: captain + m_elig + m_elig2 + m_inc + outsider = 5 active (over max=4)
    await expectError(
      "M3",
      "Team above maxTeamSize rejected at submission",
      "team_size_exceeded",
      () => teamRegService.submitTeamRegistration(captainId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Item 6: per-member eligibility blocks the whole team.
    // Remove outsider so we're at 4 (within max) but still include memberIncomplete.
    await db
      .update(schema.teamMemberships)
      .set({ status: "removed" })
      .where(
        and(
          eq(schema.teamMemberships.teamId, timUji.id),
          eq(schema.teamMemberships.userId, outsiderId),
        ),
      );
    // Roster: captain + m_elig + m_elig2 + m_inc = 4 (within bounds; one ineligible)
    await expectError(
      "M4-M6",
      "Ineligible member blocks the whole team",
      "team_member_ineligible",
      () => teamRegService.submitTeamRegistration(captainId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Item 8: non-captain calls submit → team_not_captain (after removing the incomplete member)
    await db
      .update(schema.teamMemberships)
      .set({ status: "removed" })
      .where(
        and(
          eq(schema.teamMemberships.teamId, timUji.id),
          eq(schema.teamMemberships.userId, memberIncompleteId),
        ),
      );
    // Roster: captain + m_elig + m_elig2 = 3 all eligible
    await expectError(
      "M8",
      "Non-captain member rejected with team_not_captain",
      "team_not_captain",
      () =>
        teamRegService.submitTeamRegistration(memberEligibleId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Item 10: outsider (no membership) calls submit → also team_not_captain
    await expectError(
      "M10",
      "Outsider candidate rejected with team_not_captain",
      "team_not_captain",
      () => teamRegService.submitTeamRegistration(outsiderId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Cross-competition URL forgery: team belongs to compTeamNormal, called against compTeamMin3
    await expectError(
      "CROSS-TENANT",
      "Cross-competition URL forge returns team_not_found (404), not 403",
      "team_not_found",
      () => teamRegService.submitTeamRegistration(captainId, compTeamMin3Id, timUji.id, db, NOW),
    );

    // Item 11: submit team to individual-mode competition
    // Build a team on the individual-mode competition (createTeam should fail too, but service-level
    // submission gate fires on team_competition_mode_not_allowed during create. We need a team that
    // already exists pointing at an individual-mode competition. createTeam itself rejects with
    // team_competition_mode_not_allowed before insert, so we insert directly to set up the test.
    const indivTeamId = `${TAG}_indiv_team`;
    await db.insert(schema.teams).values({
      id: indivTeamId,
      competitionId: compIndividualId,
      name: `Mode-test ${SUFFIX}`,
      captainId: captainId,
      status: "forming",
    });
    await db.insert(schema.teamMemberships).values({
      teamId: indivTeamId,
      userId: captainId,
      role: "captain",
      status: "active",
    });
    await expectError(
      "M11",
      "Submit to individual-mode competition rejected with team_registration_not_allowed",
      "team_registration_not_allowed",
      () => teamRegService.submitTeamRegistration(captainId, compIndividualId, indivTeamId, db, NOW),
    );

    // Item 12: window not yet open
    const winFutTeamId = `${TAG}_winfut_team`;
    await db.insert(schema.teams).values({
      id: winFutTeamId,
      competitionId: compWindowFutureId,
      name: `Future-win ${SUFFIX}`,
      captainId: captainId,
      status: "forming",
    });
    await db.insert(schema.teamMemberships).values({
      teamId: winFutTeamId,
      userId: captainId,
      role: "captain",
      status: "active",
    });
    await expectError(
      "M12",
      "Before registrationStartAt → registration_not_yet_open",
      "registration_not_yet_open",
      () =>
        teamRegService.submitTeamRegistration(captainId, compWindowFutureId, winFutTeamId, db, NOW),
    );

    // Item 13: window closed
    const winPastTeamId = `${TAG}_winpast_team`;
    await db.insert(schema.teams).values({
      id: winPastTeamId,
      competitionId: compWindowPastId,
      name: `Past-win ${SUFFIX}`,
      captainId: captainId,
      status: "forming",
    });
    await db.insert(schema.teamMemberships).values({
      teamId: winPastTeamId,
      userId: captainId,
      role: "captain",
      status: "active",
    });
    await expectError(
      "M13",
      "After registrationEndAt → registration_window_closed",
      "registration_window_closed",
      () =>
        teamRegService.submitTeamRegistration(captainId, compWindowPastId, winPastTeamId, db, NOW),
    );

    // Items 15-17: pre-existing individual registration blocks team submission.
    // soloId registers individually for C-TEAM-NORMAL (it's mode=team so the individual path would
    // reject; switch to a competition that has mode='both' won't help either since our seed has no
    // mode='both' comp. Easier: directly insert a confirmed individual registration row for solo.)
    await db.insert(schema.competitionRegistrations).values({
      competitionId: compTeamNormalId,
      studentId: soloId,
      registrationType: "individual",
      status: "confirmed",
      teamId: null,
    });

    // Add solo to Tim Uji's roster
    await db.insert(schema.teamMemberships).values({
      teamId: timUji.id,
      userId: soloId,
      role: "member",
      status: "active",
      joinedAt: NOW,
    });
    // Roster now: captain + m_elig + m_elig2 + solo = 4 (all eligible)

    await expectError(
      "M15-M17",
      "Member with pre-existing individual registration blocks team submit (pre-check 409)",
      "team_member_already_registered",
      () => teamRegService.submitTeamRegistration(captainId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Item 18: cancel solo's individual registration, then submit succeeds
    // Find solo's registration row
    const [soloReg] = await db
      .select({ id: schema.competitionRegistrations.id })
      .from(schema.competitionRegistrations)
      .where(
        and(
          eq(schema.competitionRegistrations.studentId, soloId),
          eq(schema.competitionRegistrations.competitionId, compTeamNormalId),
        ),
      );
    if (!soloReg) throw new Error("solo individual registration missing — seed bug");
    await regService.cancelRegistration(
      soloId,
      compTeamNormalId,
      soloReg.id,
      null,
      db,
      NOW,
    );

    await expectOk("M18", "Happy-path team submission succeeds after conflict cleared", () =>
      teamRegService.submitTeamRegistration(captainId, compTeamNormalId, timUji.id, db, NOW),
    );

    // Item 21: SQL spot-check — every active member has a type=team, status=confirmed reg row
    const teamRegsAfterSubmit = await db
      .select({
        studentId: schema.competitionRegistrations.studentId,
        regType: schema.competitionRegistrations.registrationType,
        status: schema.competitionRegistrations.status,
        teamId: schema.competitionRegistrations.teamId,
      })
      .from(schema.competitionRegistrations)
      .where(eq(schema.competitionRegistrations.teamId, timUji.id));
    const submittedMemberIds = teamRegsAfterSubmit
      .filter((r) => r.status === "confirmed" && r.regType === "team")
      .map((r) => r.studentId)
      .sort();
    const expectedMemberIds = [captainId, memberEligibleId, memberEligible2Id, soloId].sort();
    expectTrue(
      "M21",
      "After submit, each active member has a team-type confirmed registration row",
      JSON.stringify(submittedMemberIds) === JSON.stringify(expectedMemberIds),
      `expected ${JSON.stringify(expectedMemberIds)}, got ${JSON.stringify(submittedMemberIds)}`,
    );

    // Verify team status is submitted
    const [postSubmitTeam] = await db
      .select({ status: schema.teams.status })
      .from(schema.teams)
      .where(eq(schema.teams.id, timUji.id));
    expectTrue(
      "M21b",
      "After submit, team.status === 'submitted'",
      postSubmitTeam?.status === "submitted",
      `got ${postSubmitTeam?.status}`,
    );

    // Items 19, 20: Step 4.3 mutations blocked on submitted team
    await expectError(
      "M19",
      "Invite blocked on submitted team",
      "team_not_forming",
      () =>
        teamService.inviteTeamMember(
          captainId,
          timUji.id,
          { invitedEmail: `extra-${SUFFIX}@test.local` },
          db,
          NOW,
        ),
    );

    // Find an active membership id to attempt removal
    const [activeMembershipForRemove] = await db
      .select({ id: schema.teamMemberships.id })
      .from(schema.teamMemberships)
      .where(
        and(
          eq(schema.teamMemberships.teamId, timUji.id),
          eq(schema.teamMemberships.userId, memberEligibleId),
          eq(schema.teamMemberships.status, "active"),
        ),
      );
    if (!activeMembershipForRemove) throw new Error("eligible member missing — seed bug");
    await expectError(
      "M20",
      "Remove-member blocked on submitted team",
      "team_not_forming",
      () => teamService.removeTeamMember(captainId, timUji.id, activeMembershipForRemove.id, db),
    );

    // Item 22: hasActiveRegistrationsForCompetition returns true (unpublish blocked)
    const hasActive = await compAccess.hasActiveRegistrationsForCompetition(compTeamNormalId, db);
    expectTrue(
      "M22",
      "hasActiveRegistrationsForCompetition true while a team submission exists",
      hasActive === true,
    );

    // Items 23, 24: cancel registration → team reverts to forming, regs flip to cancelled
    // Step 6.5f — cancelTeamRegistration now takes a required cancellation reason and enforces the
    // F12 policy; the competition under test must have allow_cancellation enabled for this to pass.
    await expectOk("M23", "cancelTeamRegistration succeeds on submitted team", () =>
      teamRegService.cancelTeamRegistration(
        captainId,
        compTeamNormalId,
        timUji.id,
        "uji pembatalan",
        db,
        NOW,
      ),
    );

    const [postCancelTeam] = await db
      .select({ status: schema.teams.status })
      .from(schema.teams)
      .where(eq(schema.teams.id, timUji.id));
    expectTrue(
      "M23b",
      "After cancel, team.status === 'forming'",
      postCancelTeam?.status === "forming",
      `got ${postCancelTeam?.status}`,
    );

    const teamRegsAfterCancel = await db
      .select({
        studentId: schema.competitionRegistrations.studentId,
        status: schema.competitionRegistrations.status,
      })
      .from(schema.competitionRegistrations)
      .where(eq(schema.competitionRegistrations.teamId, timUji.id));
    const allCancelled = teamRegsAfterCancel.every((r) => r.status === "cancelled");
    expectTrue(
      "M24",
      "After cancel, all team-typed registration rows are cancelled",
      allCancelled,
      `statuses: ${teamRegsAfterCancel.map((r) => r.status).join(",")}`,
    );

    // hasActive should now be false
    const hasActiveAfterCancel = await compAccess.hasActiveRegistrationsForCompetition(
      compTeamNormalId,
      db,
    );
    expectTrue(
      "M22b",
      "After cancel, hasActiveRegistrationsForCompetition false (unpublish unblocked)",
      hasActiveAfterCancel === false,
    );

    // Item 25: re-submission after cancellation succeeds.
    // The pre-check now sees the previously-cancelled rows (status=cancelled, so they are filtered
    // out of the conflicting-members set).
    await expectOk("M25", "Re-submission after cancellation succeeds", () =>
      teamRegService.submitTeamRegistration(captainId, compTeamNormalId, timUji.id, db, NOW),
    );

    const [postResubmitTeam] = await db
      .select({ status: schema.teams.status })
      .from(schema.teams)
      .where(eq(schema.teams.id, timUji.id));
    expectTrue(
      "M25b",
      "After re-submission, team.status === 'submitted'",
      postResubmitTeam?.status === "submitted",
      `got ${postResubmitTeam?.status}`,
    );

    // Verify the post-resubmit registration set: there should now be a new set of
    // confirmed team-typed rows AND the old cancelled rows still present (4 + 4 = 8 rows
    // for this team).
    const allRegs = await db
      .select({
        status: schema.competitionRegistrations.status,
        regType: schema.competitionRegistrations.registrationType,
      })
      .from(schema.competitionRegistrations)
      .where(eq(schema.competitionRegistrations.teamId, timUji.id));
    const confirmedCount = allRegs.filter(
      (r) => r.status === "confirmed" && r.regType === "team",
    ).length;
    const cancelledCount = allRegs.filter((r) => r.status === "cancelled").length;
    expectTrue(
      "M25c",
      "After re-submit, 4 confirmed + 4 historical cancelled rows present",
      confirmedCount === 4 && cancelledCount === 4,
      `confirmed=${confirmedCount}, cancelled=${cancelledCount}`,
    );

    // Unpublish guard re-engaged
    const hasActiveResubmit = await compAccess.hasActiveRegistrationsForCompetition(
      compTeamNormalId,
      db,
    );
    expectTrue(
      "M22c",
      "After re-submit, hasActiveRegistrationsForCompetition true again",
      hasActiveResubmit === true,
    );
  } finally {
    console.log("\n=== Cleanup ===");
    await cleanup();
    await closeDbConnection();
  }

  console.log("\n=== Summary ===");
  const passes = results.filter((r) => r.status === "PASS").length;
  const fails = results.filter((r) => r.status === "FAIL").length;
  console.log(`${passes} passed, ${fails} failed (${results.length} total)`);
  if (fails > 0) {
    console.log("\nFailing items:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ✗ [${r.id}] ${r.description}: ${r.detail ?? ""}`);
    }
    process.exit(1);
  }
};

run().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
