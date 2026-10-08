import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SERVICE = "src/server/competitions/competition-service.ts";
const SHELL = "src/components/institution/institution-competition-edit-shell.tsx";
const SERVICE_TEST = "src/server/competitions/competition-service.lifecycle.test.ts";
const SHELL_TEST = "src/components/institution/institution-competition-edit-shell.test.tsx";
const SERVICE_REACHED =
  /× .*handles a 'unchanged past' registration deadline after registration closes/;
const SHELL_REACHED =
  /× .*sends only changed fields for published saves and every field for drafts \(published\)/;

const DEADLINE_SKIP =
  "  if (immutableCompetitionValuesEqual(registrationEndAt, storedRegistrationEndAt)) return;\n";
const DEADLINE_CHECK = "  validateRegistrationEndInFuture(registrationEndAt);\n";
const FIELD_SKIP = "        if (unchanged) delete patch[field];";

export const probes = [
  {
    name: "published deadline: unchanged-value skip REMOVED",
    klass: "D",
    harmfulMove:
      "validating an unchanged past deadline, refusing an otherwise valid description save",
    files: [SERVICE],
    appliedMarkers: ["  void storedRegistrationEndAt;"],
    mutate: () => substituteOnce(SERVICE, DEADLINE_SKIP, "  void storedRegistrationEndAt;\n"),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], SERVICE_REACHED),
  },
  {
    name: "published deadline: unchanged-value skip MOVED after future validation",
    klass: "D",
    harmfulMove: "running the throwing future check before the skip can accept the stored deadline",
    files: [SERVICE],
    appliedMarkers: [DEADLINE_CHECK + DEADLINE_SKIP],
    mutate: () =>
      substituteOnce(SERVICE, DEADLINE_SKIP + DEADLINE_CHECK, DEADLINE_CHECK + DEADLINE_SKIP),
    detect: async () => fails("npx", ["vitest", "run", SERVICE_TEST], SERVICE_REACHED),
  },
  {
    name: "published shell: unchanged-field skip REMOVED",
    klass: "D",
    harmfulMove: "serializing every mutable field instead of the changed form fields",
    files: [SHELL],
    appliedMarkers: ["        void [field, unchanged];"],
    mutate: () => substituteOnce(SHELL, FIELD_SKIP, "        void [field, unchanged];"),
    detect: async () => fails("npx", ["vitest", "run", SHELL_TEST], SHELL_REACHED),
  },
  {
    name: "published shell: unchanged-field skip MOVED after serialization",
    klass: "D",
    harmfulMove: "deleting unchanged keys after the outgoing JSON already contains them",
    files: [SHELL],
    appliedMarkers: ["body: serializedPatch"],
    mutate: () => {
      substituteOnce(
        SHELL,
        "    if (isPublished && savedSnapshot) {",
        "    const serializedPatch = JSON.stringify(patch);\n\n    if (isPublished && savedSnapshot) {",
      );
      substituteOnce(SHELL, "body: JSON.stringify(patch)", "body: serializedPatch");
    },
    detect: async () => fails("npx", ["vitest", "run", SHELL_TEST], SHELL_REACHED),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("published-edit-unchanged", [
    ["npx", ["vitest", "run", SERVICE_TEST, SHELL_TEST]],
  ]);
  await runProbes(probes);
}
