// One-shot integration harness for the Step 4.4 round-2 (OOB + pre-close fix) checklist.
// Covers programmatically-verifiable items: DB CHECK invariant, file-system orphan removal,
// route handler session-mismatch behaviour, post-login forwarder. UI-rendered items (modal,
// detail page CTA visuals, /registration sub-page mode gating) are left for the human.
//
// Run with: node --import tsx src/server/scripts/test-step-4.4-oob.ts

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const loadLocalEnvFiles = (): void => {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
};

type Result = { id: string; description: string; status: "PASS" | "FAIL"; detail?: string };
const results: Result[] = [];

const record = (id: string, description: string, status: "PASS" | "FAIL", detail?: string) => {
  results.push({ id, description, status, detail });
  const tag = status === "PASS" ? "✓" : "✗";
  console.log(`${tag} [${id}] ${description}${detail ? ` — ${detail}` : ""}`);
};

const expectTrue = (id: string, description: string, condition: boolean, detail?: string) => {
  record(id, description, condition ? "PASS" : "FAIL", detail);
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
      record(
        id,
        description,
        "FAIL",
        `expected ${expectedCode}, got ${code ?? "(no code)"}: ${msg}`,
      );
    }
  }
};

const pgCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (e as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return undefined;
};

const fileExists = (relPath: string): boolean => {
  try {
    statSync(join(ROOT, relPath));
    return true;
  } catch {
    return false;
  }
};

const fileContains = (relPath: string, needle: string | RegExp): boolean => {
  try {
    const text = readFileSync(join(ROOT, relPath), "utf-8");
    return typeof needle === "string" ? text.includes(needle) : needle.test(text);
  } catch {
    return false;
  }
};

const run = async (): Promise<void> => {
  loadLocalEnvFiles();
  process.env.RUNTIME_NAME = process.env.RUNTIME_NAME ?? "web";

  console.log("\n=== File-system + source-level checks ===");

  // Item 34 — deleted route
  expectTrue(
    "F34",
    "/auth/second-role-prompt page directory no longer exists",
    !fileExists("src/app/auth/second-role-prompt"),
  );

  // Item 35 — post-login forwarder
  expectTrue(
    "F35a",
    "/auth/post-login/page.tsx exists",
    fileExists("src/app/auth/post-login/page.tsx"),
  );
  expectTrue(
    "F35b",
    "/auth/post-login/page.tsx redirects to '/'",
    fileContains("src/app/auth/post-login/page.tsx", /redirect\(["']\/["']\)/),
  );
  expectTrue(
    "F35c",
    "/auth/post-login/page.tsx does NOT call decidePostLoginDestination",
    !fileContains("src/app/auth/post-login/page.tsx", "decidePostLoginDestination"),
  );

  // Item 38 — orphan helper removal
  expectTrue(
    "F38a",
    "decidePostLoginDestination no longer exported from role-verification.ts",
    !fileContains("src/server/auth/role-verification.ts", /export const decidePostLoginDestination/),
  );
  expectTrue(
    "F38b",
    "role-verification.test.ts no longer imports decidePostLoginDestination",
    !fileContains("src/server/auth/role-verification.test.ts", "decidePostLoginDestination"),
  );

  // Detail page CTA — quick source-level sanity that the disabled button and Link branches exist
  expectTrue(
    "F1-3a",
    "Detail page renders a navigation Link (not inline mutation) when ctaState='open' && isCandidate",
    fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/page.tsx",
      /href={registrationPath}/,
    ),
  );
  expectTrue(
    "F1-3b",
    "Detail page no longer imports RegisterButton",
    !fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/page.tsx",
      "RegisterButton",
    ),
  );
  expectTrue(
    "F1-3c",
    "Old register-button.tsx deleted",
    !fileExists("src/app/competitions/[institutionSlug]/[slug]/register-button.tsx"),
  );

  // /registration subpage exists and contains its mode-conditional sections
  expectTrue(
    "F7-10a",
    "/registration subpage exists",
    fileExists("src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx"),
  );
  expectTrue(
    "F7-10b",
    "Registration page server-redirects unauthenticated users",
    fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx",
      /redirect\(`\/auth\/sign-in/,
    ),
  );
  expectTrue(
    "F7-10c",
    "Registration page renders a non-leaking message for non-candidate roles",
    fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx",
      "Hanya kandidat yang dapat mendaftar",
    ),
  );
  expectTrue(
    "F7-10d",
    "Registration page renders IndividualRegistrationSection conditionally on mode",
    fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx",
      /supportsIndividual && \(/,
    ),
  );
  expectTrue(
    "F7-10e",
    "Registration page renders CompetitionTeamSection conditionally on mode",
    fileContains(
      "src/app/competitions/[institutionSlug]/[slug]/registration/page.tsx",
      /supportsTeams && \(/,
    ),
  );

  // Item 24-26 — privacy fix on team invitation page
  expectTrue(
    "F24-26a",
    "Team invitation actions hide the invited email on mismatch",
    fileContains(
      "src/app/team-invitations/[token]/invitation-actions.tsx",
      "Undangan ini ditujukan untuk alamat email lain",
    ),
  );
  expectTrue(
    "F24-26b",
    "Team invitation actions no longer render the invited email in the mismatch branch",
    !fileContains(
      "src/app/team-invitations/[token]/invitation-actions.tsx",
      /ditujukan kepada\s*<strong>{props.invitedEmail}/,
    ),
  );

  // Item 27-29 — color fix on invitation accept shell
  expectTrue(
    "F27-29a",
    "InvitationAcceptShell branches accepted -> info phase",
    fileContains(
      "src/components/invitation/invitation-accept-shell.tsx",
      /invitation\.status === "accepted"[\s\S]*phase:\s*"info"/,
    ),
  );
  expectTrue(
    "F27-29b",
    "InvitationAcceptShell renders accepted message in green (text-green-700)",
    fileContains(
      "src/components/invitation/invitation-accept-shell.tsx",
      "text-green-700",
    ),
  );

  // Modal — auto-show guarded by PENDING_PROMPT_KEY (items 13-18)
  expectTrue(
    "F13-18a",
    "Sign-in form sets PENDING_PROMPT_KEY before redirect",
    fileContains(
      "src/components/auth/sign-in-form.tsx",
      /sessionStorage\.setItem\(PENDING_PROMPT_KEY/,
    ),
  );
  expectTrue(
    "F13-18b",
    "Modal reads + clears PENDING_PROMPT_KEY on first authenticated mount",
    fileContains(
      "src/components/auth/second-role-prompt-modal.tsx",
      /sessionStorage\.getItem\(PENDING_PROMPT_KEY\)/,
    ),
  );
  expectTrue(
    "F13-18c",
    "Modal uses consumedPendingFlag ref to prevent double-fire",
    fileContains(
      "src/components/auth/second-role-prompt-modal.tsx",
      "consumedPendingFlag",
    ),
  );

  // Profile re-trigger button (items 20-21)
  expectTrue(
    "F20-21a",
    "Profile page renders VerifyOtherRoleButton when exactly one role unverified",
    fileContains(
      "src/app/profile/page.tsx",
      /profile\.candidateVerified !== profile\.recruiterVerified/,
    ),
  );
  expectTrue(
    "F20-21b",
    "VerifyOtherRoleButton dispatches SHOW_SECOND_ROLE_PROMPT_EVENT",
    fileContains(
      "src/app/profile/verify-other-role-button.tsx",
      /dispatchEvent\(new Event\(SHOW_SECOND_ROLE_PROMPT_EVENT\)\)/,
    ),
  );

  // Fix 1 wiring (the new error code + handler are in place)
  expectTrue(
    "FIX1a",
    "team-core.ts defines team_registration_invariant_violation error code",
    fileContains(
      "src/server/teams/team-core.ts",
      /team_registration_invariant_violation:\s*422/,
    ),
  );
  expectTrue(
    "FIX1b",
    "submitTeamRegistration catches pg error code 23514",
    fileContains(
      "src/server/teams/team-registration-service.ts",
      /code === "23514"/,
    ),
  );

  // Fix 2 wiring (helper removed)
  expectTrue(
    "FIX2",
    "decidePostLoginDestination is no longer present in the codebase",
    !fileContains(
      "src/server/auth/role-verification.ts",
      "decidePostLoginDestination",
    ),
  );

  // Carry-forward debt comment (4.4-D2)
  expectTrue(
    "D2",
    "Individual registration service carries the 4.4-D2 debt comment",
    fileContains("src/server/registrations/registration-service.ts", "4.4-D2"),
  );

  // Session-mismatch guard wiring across user-owned mutation endpoints
  const guardedEndpoints = [
    "src/app/api/v1/users/me/profile/route.ts",
    "src/app/api/v1/students/me/eligibility/route.ts",
    "src/app/api/v1/competitions/[competitionId]/registrations/route.ts",
    "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/route.ts",
    "src/app/api/v1/competitions/[competitionId]/teams/route.ts",
    "src/app/api/v1/competitions/[competitionId]/teams/[teamId]/registrations/route.ts",
    "src/app/api/v1/competitions/[competitionId]/save/route.ts",
    "src/app/api/v1/teams/[teamId]/route.ts",
    "src/app/api/v1/teams/[teamId]/invitations/route.ts",
    "src/app/api/v1/teams/[teamId]/invitations/[invitationId]/route.ts",
    "src/app/api/v1/teams/[teamId]/memberships/[membershipId]/route.ts",
  ];
  for (const ep of guardedEndpoints) {
    expectTrue(
      `GUARD:${ep}`,
      `calls assertSessionMatchesExpectedUser`,
      fileContains(ep, "assertSessionMatchesExpectedUser"),
    );
  }

  console.log("\n=== DB-level CHECK invariant assertions ===");

  // Items 36 + 37 — direct DB insert that should violate the type/team_id co-presence CHECK
  const { getDb, closeDbConnection } = await import("@/server/db/client");
  const schema = await import("@/server/db/schema");
  const { assertRuntimeEnv, resolveServerRuntime } = await import("@/config/env.server");
  assertRuntimeEnv(resolveServerRuntime(process.env.RUNTIME_NAME));

  const db = getDb();
  const SUFFIX = `oob-${Date.now()}`;
  const TAG = `__test_${SUFFIX}__`;

  const institutionId = `${TAG}_inst`;
  const userId = `${TAG}_user`;
  const competitionId = `${TAG}_comp`;
  const teamId = `${TAG}_team`;

  const NOW = new Date();
  const FUTURE = new Date(Date.now() + 30 * 86_400_000);

  const { eq, inArray } = await import("drizzle-orm");

  const cleanup = async () => {
    try {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db
        .delete(schema.competitions)
        .where(inArray(schema.competitions.id, [competitionId]));
      await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
    } catch (err) {
      console.error("cleanup error (non-fatal):", err);
    }
  };

  try {
    await db.insert(schema.institutions).values({
      id: institutionId,
      displayName: `OOB inst ${SUFFIX}`,
      slug: `oob-inst-${SUFFIX}`.toLowerCase(),
      status: "active",
      verificationStatus: "verified",
      verifiedAt: NOW,
    });
    await db.insert(schema.users).values({
      id: userId,
      username: `oob_user_${SUFFIX}`,
      email: `oob-${SUFFIX}@test.local`,
      name: "OOB",
      role: "candidate",
      status: "active",
      candidateVerifiedAt: NOW,
    });
    await db.insert(schema.competitions).values({
      id: competitionId,
      institutionId,
      createdByUserId: userId,
      slug: `oob-comp-${SUFFIX}`.toLowerCase(),
      title: `OOB Comp ${SUFFIX}`,
      description: "test",
      status: "published",
      mode: "team",
      minTeamSize: 1,
      maxTeamSize: 4,
      registrationStartAt: new Date(Date.now() - 86_400_000),
      registrationEndAt: FUTURE,
      eventStartAt: FUTURE,
      eventEndAt: new Date(FUTURE.getTime() + 86_400_000),
      publishedAt: NOW,
    });
    await db.insert(schema.teams).values({
      id: teamId,
      competitionId,
      name: `OOB Team ${SUFFIX}`,
      captainId: userId,
      status: "forming",
    });

    // Item 36 — type='team' AND team_id IS NULL
    await expectError(
      "F36",
      "DB rejects team-type row with NULL team_id (CHECK 23514)",
      "23514",
      async () => {
        try {
          await db.insert(schema.competitionRegistrations).values({
            competitionId,
            studentId: userId,
            registrationType: "team",
            status: "confirmed",
            teamId: null,
          });
        } catch (err) {
          throw Object.assign(new Error(String(err)), { code: pgCode(err) });
        }
      },
    );

    // Item 37 — type='individual' AND team_id non-null
    await expectError(
      "F37",
      "DB rejects individual-type row with non-NULL team_id (CHECK 23514)",
      "23514",
      async () => {
        try {
          await db.insert(schema.competitionRegistrations).values({
            competitionId,
            studentId: userId,
            registrationType: "individual",
            status: "confirmed",
            teamId,
          });
        } catch (err) {
          throw Object.assign(new Error(String(err)), { code: pgCode(err) });
        }
      },
    );
  } finally {
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
