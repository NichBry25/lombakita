import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

const REGISTRATION_SERVICE = "src/server/registrations/registration-service.ts";
const TEAM_ROW_CANCEL_TEST =
  "src/server/registrations/registration-team-cancel-db.integration.test.ts";
const REFUSAL_CASE = "refuses a captain's own team row and a member's, and changes no row";

/** A literal for embedding in a `reached` pattern, so a title containing `.` or `(` still matches. */
const regexFree = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const refusalCaseFailed = () =>
  fails(
    "npx",
    ["vitest", "run", TEAM_ROW_CANCEL_TEST, "-t", REFUSAL_CASE],
    new RegExp(`× .*${regexFree(REFUSAL_CASE)}`),
  );

/**
 * The individual cancel's refusal of a team row, exactly as it stands in `cancelRegistration`.
 *
 * The trailing blank line is part of it, so removing it does not leave the file with two blank
 * lines where the guard was: the mutation has to be the removal or the move and nothing else.
 */
const TEAM_ROW_REFUSAL = [
  "  // The registration_type CHECK ties registration_type 'team' to a non-null team_id, and no code",
  "  // path changes either column on an existing row, so this read cannot go stale before the write.",
  '  if (registration.registrationType === "team") {',
  "    throw new RegistrationError(",
  '      "registration_team_row_use_team_flow",',
  '      "Pendaftaran ini terdaftar sebagai tim. Hanya ketua tim yang dapat membatalkan pendaftaran tim, lewat bagian Tim di halaman ini.",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

const TEAM_ROW_REFUSAL_REMOVED = "  // probe: the team-row refusal is gone\n\n";

const TEAM_ROW_REFUSAL_MOVED = [
  "  // probe: the team-row refusal now runs after the cancellation has committed",
  '  if (registration.registrationType === "team") {',
  "    throw new RegistrationError(",
  '      "registration_team_row_use_team_flow",',
  '      "Pendaftaran ini terdaftar sebagai tim. Hanya ketua tim yang dapat membatalkan pendaftaran tim, lewat bagian Tim di halaman ini.",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

export const probes = [
  {
    name: "a candidate cancels a team row through the individual cancel — TEAM-ROW REFUSAL REMOVED",
    klass: "A1-pre",
    harmfulMove:
      "deleting the refusal, so a captain or a member cancels their own team row through the " +
      "individual endpoint: the team's payment anchor is cancelled, every later proof is refused " +
      "and the expiry later cancels the other members. The refusal has no second copy inside the " +
      "transaction, so removing it removes the only one",
    files: [REGISTRATION_SERVICE],
    appliedMarkers: ["// probe: the team-row refusal is gone"],
    mutate: () => substituteOnce(REGISTRATION_SERVICE, TEAM_ROW_REFUSAL, TEAM_ROW_REFUSAL_REMOVED),
    detect: async () => refusalCaseFailed(),
  },
  {
    name: "a candidate cancels a team row through the individual cancel — TEAM-ROW REFUSAL MOVED BELOW THE TRANSACTION",
    klass: "A1-pre",
    harmfulMove:
      "moving the refusal below `db.transaction`, where it throws the identical error after the " +
      "team row's cancellation has committed: the caller still reads a refusal while the row is " +
      "already cancelled. Moving it within the transaction callback would be benign and is not " +
      "the move probed here",
    files: [REGISTRATION_SERVICE],
    appliedMarkers: [
      "// probe: the team-row refusal now runs after the cancellation has committed",
    ],
    mutate: () => {
      substituteOnce(REGISTRATION_SERVICE, TEAM_ROW_REFUSAL, "");
      substituteOnce(
        REGISTRATION_SERVICE,
        "  if (!updated) {\n",
        TEAM_ROW_REFUSAL_MOVED + "  if (!updated) {\n",
      );
    },
    detect: async () => refusalCaseFailed(),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("team-row-cancel", [
    ["npx", ["vitest", "run", TEAM_ROW_CANCEL_TEST, "-t", REFUSAL_CASE]],
  ]);
  await runProbes(probes);
}
