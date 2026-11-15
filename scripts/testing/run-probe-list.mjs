/*
 * Runs a list of Rule 36 probes that is written as data, through the harness in guard-probe.mjs.
 *
 * Usage: node scripts/testing/run-probe-list.mjs <path of a probe list JSON file>
 *
 * The list is {"probes": [{name, klass, harmfulMove, files, repo?, edits, appliedMarkers,
 * detector}]}, where `edits` are {file, find, replace} and `detector` is {command, args, reached?}.
 * Each edit goes through `substituteOnce`, so an anchor that is absent or ambiguous stops the probe
 * before the detector runs. The detector is `fails` from the shared detectors.
 *
 * Compile, applied, reached, restore and teardown all belong to `runProbes`. This file adds no
 * restore, no git call and no file write, so a probe list cannot do more than the harness does.
 *
 * A list this file cannot classify is refused rather than run. Every refusal is one line starting
 * `run-probe-list REFUSED: ` on stderr, and the exit code is 2.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runProbes, substituteOnce } from "./guard-probe.mjs";
import { fails } from "./probes/detectors.mjs";

export const GUARD_CLASSES = ["A1-in", "A1-pre", "A2", "B", "C", "D"];

const PROBE_KEYS = {
  required: ["name", "klass", "harmfulMove", "files", "edits", "appliedMarkers", "detector"],
  optional: ["repo"],
};
const EDIT_KEYS = { required: ["file", "find", "replace"], optional: [] };
const DETECTOR_KEYS = { required: ["command", "args"], optional: ["reached"] };

export class ProbeListRefusal extends Error {}

const refuse = (message) => {
  throw new ProbeListRefusal(message);
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const requireKeys = (owner, value, keys, where) => {
  for (const key of keys.required) {
    if (!(key in value)) refuse(`${owner}: missing key "${where}${key}"`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.required.includes(key) && !keys.optional.includes(key)) {
      refuse(`${owner}: key "${where}${key}" is not in the probe list shape`);
    }
  }
};

const requireString = (owner, value, key) => {
  if (typeof value !== "string") refuse(`${owner}: key "${key}" must be a string`);
};

const requireNonEmptyList = (owner, value, key) => {
  if (!Array.isArray(value)) refuse(`${owner}: key "${key}" must be a list`);
  if (value.length === 0) refuse(`${owner}: key "${key}" is an empty list`);
};

const requireEdit = (owner, edit, position, files) => {
  const where = `edits[${position}].`;
  if (!isPlainObject(edit)) refuse(`${owner}: key "edits[${position}]" must be an object`);
  requireKeys(owner, edit, EDIT_KEYS, where);
  for (const key of EDIT_KEYS.required) requireString(owner, edit[key], `${where}${key}`);
  if (!files.includes(edit.file)) {
    refuse(`${owner}: key "${where}file" names ${edit.file}, which is not in files`);
  }
};

const requireDetector = (owner, detector) => {
  if (!isPlainObject(detector)) refuse(`${owner}: key "detector" must be an object`);
  requireKeys(owner, detector, DETECTOR_KEYS, "detector.");
  requireString(owner, detector.command, "detector.command");
  if (!isStringList(detector.args))
    refuse(`${owner}: key "detector.args" must be a list of strings`);
  if (detector.reached === undefined) return;
  requireString(owner, detector.reached, "detector.reached");
  try {
    new RegExp(detector.reached);
  } catch {
    refuse(`${owner}: key "detector.reached" is not a valid regular expression`);
  }
};

const requireProbe = (probe, position) => {
  const label = isPlainObject(probe) && typeof probe.name === "string" ? probe.name : "";
  const owner = label === "" ? `probe #${position + 1}` : `probe "${label}"`;
  if (!isPlainObject(probe)) refuse(`${owner}: must be an object`);
  requireKeys(owner, probe, PROBE_KEYS, "");
  requireString(owner, probe.name, "name");
  requireString(owner, probe.harmfulMove, "harmfulMove");
  if (!GUARD_CLASSES.includes(probe.klass)) {
    refuse(`${owner}: key "klass" must be one of ${GUARD_CLASSES.join(", ")}`);
  }
  requireNonEmptyList(owner, probe.files, "files");
  if (!isStringList(probe.files)) refuse(`${owner}: key "files" must be a list of strings`);
  if (probe.repo !== undefined) requireString(owner, probe.repo, "repo");
  requireNonEmptyList(owner, probe.edits, "edits");
  probe.edits.forEach((edit, editPosition) => requireEdit(owner, edit, editPosition, probe.files));
  requireNonEmptyList(owner, probe.appliedMarkers, "appliedMarkers");
  if (!isStringList(probe.appliedMarkers)) {
    refuse(`${owner}: key "appliedMarkers" must be a list of strings`);
  }
  requireDetector(owner, probe.detector);
};

/** Reads and validates a probe list file. Every shape it cannot classify is a refusal. */
export const readProbeList = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refuse(`cannot read the probe list at ${path}`);
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    return refuse(`the probe list at ${path} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(list)) refuse(`the probe list at ${path} must be an object`);
  for (const key of Object.keys(list)) {
    if (key !== "probes") refuse(`key "${key}" is not in the probe list shape`);
  }
  if (!("probes" in list)) refuse('missing key "probes"');
  requireNonEmptyList("the probe list", list.probes, "probes");
  list.probes.forEach(requireProbe);
  return list;
};

const applyEdits = (edits) => {
  for (const edit of edits) substituteOnce(edit.file, edit.find, edit.replace);
};

/** Turns a validated list into harness probes. Nothing is applied or run here. */
export const buildHarnessProbes = (list) =>
  list.probes.map((spec) => {
    const reached =
      spec.detector.reached === undefined ? undefined : new RegExp(spec.detector.reached);
    return {
      name: spec.name,
      klass: spec.klass,
      harmfulMove: spec.harmfulMove,
      files: spec.files,
      ...(spec.repo === undefined ? {} : { repo: spec.repo }),
      appliedMarkers: spec.appliedMarkers,
      mutate: () => applyEdits(spec.edits),
      detect: async () => fails(spec.detector.command, spec.detector.args, reached),
    };
  });

const REFUSAL_EXIT_CODE = 2;

const pathFromArgs = (args) => {
  const [path] = args;
  if (path === undefined) return refuse("give the path of a probe list JSON file");
  if (args.length > 1) refuse(`unexpected argument "${args[1]}"`);
  return path;
};

const main = async () => {
  let probes;
  try {
    const path = pathFromArgs(process.argv.slice(2));
    probes = buildHarnessProbes(readProbeList(path));
  } catch (error) {
    if (!(error instanceof ProbeListRefusal)) throw error;
    console.error(`run-probe-list REFUSED: ${error.message}`);
    process.exit(REFUSAL_EXIT_CODE);
  }
  await runProbes(probes);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
