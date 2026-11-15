// @vitest-environment node

/**
 * The probe list runner: what it refuses, and what it turns a valid list into.
 *
 * Nothing here runs a probe through the harness. A refusal case is a list with one defect, written
 * to a temporary folder that is removed in a `finally`, run through the real command line.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHarnessProbes, readProbeList, type ProbeList } from "./run-probe-list.mjs";

const REFUSAL_PREFIX = "run-probe-list REFUSED: ";

const validList = (): Record<string, unknown> => ({
  probes: [
    {
      name: "first",
      klass: "D",
      harmfulMove: "a defect passes unseen",
      files: ["scripts/one.txt", "scripts/two.txt"],
      edits: [{ file: "scripts/one.txt", find: "before", replace: "after" }],
      appliedMarkers: ["after"],
      detector: { command: "npm", args: ["run", "test"] },
    },
  ],
});

const withWorkspace = <T>(body: (folder: string) => T): T => {
  const folder = mkdtempSync(join(tmpdir(), "run-probe-list-"));
  try {
    return body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const runnerOn = (path: string) =>
  spawnSync("node", ["scripts/testing/run-probe-list.mjs", path], { encoding: "utf8" });

const runnerOnText = (text: string) =>
  withWorkspace((folder) => {
    const path = join(folder, "list.json");
    writeFileSync(path, text);
    return runnerOn(path);
  });

type Damage = (list: Record<string, unknown>) => void;

const firstProbe = (list: Record<string, unknown>): Record<string, unknown> => {
  const probes = list.probes as Record<string, unknown>[];
  return probes[0] as Record<string, unknown>;
};

const withoutKey = (key: string): Damage => {
  return (list) => {
    delete firstProbe(list)[key];
  };
};

const withProbeKey = (key: string, value: unknown): Damage => {
  return (list) => {
    firstProbe(list)[key] = value;
  };
};

const withDetector = (change: Record<string, unknown>): Damage => {
  return (list) => {
    const detector = firstProbe(list).detector as Record<string, unknown>;
    Object.assign(detector, change);
  };
};

describe("refusals", () => {
  it.each([
    {
      name: "an unknown top-level key",
      damage: (list) => Object.assign(list, { extra: 1 }),
      message: 'key "extra" is not in the probe list shape',
    },
    {
      name: "a missing probes key",
      damage: (list) => delete list.probes,
      message: 'missing key "probes"',
    },
    {
      name: "an empty probes list",
      damage: (list) => Object.assign(list, { probes: [] }),
      message: 'the probe list: key "probes" is an empty list',
    },
    { name: "a missing name", damage: withoutKey("name"), message: 'probe #1: missing key "name"' },
    {
      name: "a missing klass",
      damage: withoutKey("klass"),
      message: 'probe "first": missing key "klass"',
    },
    {
      name: "a missing harmfulMove",
      damage: withoutKey("harmfulMove"),
      message: 'probe "first": missing key "harmfulMove"',
    },
    {
      name: "a missing files",
      damage: withoutKey("files"),
      message: 'probe "first": missing key "files"',
    },
    {
      name: "a missing edits",
      damage: withoutKey("edits"),
      message: 'probe "first": missing key "edits"',
    },
    {
      name: "a missing appliedMarkers",
      damage: withoutKey("appliedMarkers"),
      message: 'probe "first": missing key "appliedMarkers"',
    },
    {
      name: "a missing detector",
      damage: withoutKey("detector"),
      message: 'probe "first": missing key "detector"',
    },
    {
      name: "a key that is not in the shape",
      damage: withProbeKey("repoo", "docs"),
      message: 'probe "first": key "repoo" is not in the probe list shape',
    },
    {
      name: "an empty files list",
      damage: withProbeKey("files", []),
      message: 'probe "first": key "files" is an empty list',
    },
    {
      name: "an empty edits list",
      damage: withProbeKey("edits", []),
      message: 'probe "first": key "edits" is an empty list',
    },
    {
      name: "an empty appliedMarkers list",
      damage: withProbeKey("appliedMarkers", []),
      message: 'probe "first": key "appliedMarkers" is an empty list',
    },
    {
      name: "an empty name",
      damage: withProbeKey("name", ""),
      message: 'probe #1: key "name" is an empty string',
    },
    {
      name: "an empty harmfulMove",
      damage: withProbeKey("harmfulMove", ""),
      message: 'probe "first": key "harmfulMove" is an empty string',
    },
    {
      name: "an empty string in files",
      damage: withProbeKey("files", [""]),
      message: 'probe "first": key "files[0]" is an empty string',
    },
    {
      name: "an edit with an empty find",
      damage: withProbeKey("edits", [{ file: "scripts/one.txt", find: "", replace: "b" }]),
      message: 'probe "first": key "edits[0].find" is an empty string',
    },
    {
      name: "an empty string in appliedMarkers",
      damage: withProbeKey("appliedMarkers", [""]),
      message: 'probe "first": key "appliedMarkers[0]" is an empty string',
    },
    {
      name: "an empty detector command",
      damage: withDetector({ command: "" }),
      message: 'probe "first": key "detector.command" is an empty string',
    },
    {
      name: "a klass outside the list",
      damage: withProbeKey("klass", "E"),
      message: 'probe "first": key "klass" must be one of A1-in, A1-pre, A2, B, C, D',
    },
    {
      name: "an edit whose file is not in files",
      damage: withProbeKey("edits", [{ file: "scripts/other.txt", find: "a", replace: "b" }]),
      message: 'probe "first": key "edits[0].file" names scripts/other.txt, which is not in files',
    },
    {
      name: "an edit with a missing key",
      damage: withProbeKey("edits", [{ file: "scripts/one.txt", find: "a" }]),
      message: 'probe "first": missing key "edits[0].replace"',
    },
    {
      name: "an edit with a key that is not in the shape",
      damage: withProbeKey("edits", [
        { file: "scripts/one.txt", find: "a", replace: "b", all: true },
      ]),
      message: 'probe "first": key "edits[0].all" is not in the probe list shape',
    },
    {
      name: "a detector with a missing key",
      damage: withDetector({ args: undefined }),
      message: 'probe "first": missing key "detector.args"',
    },
    {
      name: "a detector with a key that is not in the shape",
      damage: withDetector({ timeout: 5 }),
      message: 'probe "first": key "detector.timeout" is not in the probe list shape',
    },
    {
      name: "an empty reached",
      damage: withDetector({ reached: "" }),
      message: 'probe "first": key "detector.reached" is an empty string',
    },
    {
      name: "a reached that is not a regular expression",
      damage: withDetector({ reached: "(" }),
      message: 'probe "first": key "detector.reached" is not a valid regular expression',
    },
  ] satisfies { name: string; damage: Damage; message: string }[])(
    "refuses $name, naming the probe and the key, and exits 2",
    ({ damage, message }) => {
      const list = validList();
      damage(list);
      const result = runnerOnText(JSON.stringify(list));
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${REFUSAL_PREFIX}${message}`);
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    },
  );

  it("refuses a detector that is missing a required key", () => {
    const list = validList();
    delete (firstProbe(list).detector as Record<string, unknown>).command;
    const result = runnerOnText(JSON.stringify(list));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `${REFUSAL_PREFIX}probe "first": missing key "detector.command"`,
    );
  });

  it("refuses when no file is given", () => {
    const result = spawnSync("node", ["scripts/testing/run-probe-list.mjs"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`${REFUSAL_PREFIX}give the path of a probe list JSON file\n`);
  });

  it("refuses a file that does not exist", () => {
    const result = withWorkspace((folder) => runnerOn(join(folder, "absent.json")));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      /^run-probe-list REFUSED: cannot read the probe list at .*absent\.json\n$/,
    );
  });

  it("refuses JSON that does not parse", () => {
    const result = runnerOnText("{ not json");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      /^run-probe-list REFUSED: the probe list at .* is not valid JSON: /,
    );
  });
});

describe("running a list through the harness", () => {
  const TRACKED_FILE = "probed.yml";
  const MARKER = "PROBE_MARKER";
  const RUNNER = join(process.cwd(), "scripts/testing/run-probe-list.mjs");

  const runGit = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

  const withTemporaryRepository = <T>(body: (repository: string) => T): T =>
    withWorkspace((folder) => {
      const repository = realpathSync(folder);
      runGit(repository, ["init", "--quiet"]);
      runGit(repository, ["config", "user.email", "probe@example.invalid"]);
      runGit(repository, ["config", "user.name", "probe"]);
      writeFileSync(join(repository, TRACKED_FILE), "before: 1\n");
      runGit(repository, ["add", TRACKED_FILE]);
      runGit(repository, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "one tracked file",
      ]);
      return body(repository);
    });

  const detectorReadingMarker = [
    'const text = require("node:fs").readFileSync("probed.yml", "utf8");',
    `if (text.includes("${MARKER}")) { console.log("FAIL marker present"); process.exit(1); }`,
  ].join(" ");

  const listWithDetector = (script: string) => ({
    probes: [
      {
        name: "marker probe",
        klass: "D",
        harmfulMove: "the marker is written into the tracked file",
        files: [TRACKED_FILE],
        edits: [{ file: TRACKED_FILE, find: "before", replace: MARKER }],
        appliedMarkers: [MARKER],
        detector: { command: "node", args: ["-e", script] },
      },
    ],
  });

  const runListIn = (repository: string, list: unknown) => {
    const listPath = join(repository, "list.json");
    writeFileSync(listPath, JSON.stringify(list));
    return spawnSync("node", [RUNNER, listPath], { cwd: repository, encoding: "utf8" });
  };

  const treeIsClean = (repository: string): boolean => {
    try {
      runGit(repository, ["diff", "--quiet"]);
      return true;
    } catch {
      return false;
    }
  };

  it("runs a probe whose detector goes red, and leaves the tracked file clean", () => {
    withTemporaryRepository((repository) => {
      const result = runListIn(repository, listWithDetector(detectorReadingMarker));
      expect(result.stderr).not.toContain("NOT PROVEN");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("1/1 probes went red as claimed.");
      expect(treeIsClean(repository)).toBe(true);
    });
  });

  it("reports NOT PROVEN and exits non-zero when the detector stays green, and leaves the tree clean", () => {
    withTemporaryRepository((repository) => {
      const result = runListIn(repository, listWithDetector("process.exit(0)"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("NOT PROVEN: marker probe");
      expect(treeIsClean(repository)).toBe(true);
    });
  });

  it("stops before any probe when the detector already fails at HEAD, and leaves the tree clean", () => {
    withTemporaryRepository((repository) => {
      const alwaysRed = 'console.log("FAIL always"); process.exit(1);';
      const result = runListIn(repository, listWithDetector(alwaysRed));
      const stdoutLines = result.stdout.split("\n");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/^Error: CONTROL:/m);
      expect(stdoutLines.some((line) => line.startsWith("RED"))).toBe(false);
      expect(treeIsClean(repository)).toBe(true);
    });
  });
});

describe("building harness probes", () => {
  const readValid = (): ProbeList =>
    withWorkspace((folder) => {
      const path = join(folder, "list.json");
      writeFileSync(path, JSON.stringify(validList()));
      return readProbeList(path);
    });

  it("turns a valid list into probes with the same fields", () => {
    const [probe, ...rest] = buildHarnessProbes(readValid());
    expect(rest).toEqual([]);
    expect(probe).toMatchObject({
      name: "first",
      klass: "D",
      harmfulMove: "a defect passes unseen",
      files: ["scripts/one.txt", "scripts/two.txt"],
      appliedMarkers: ["after"],
    });
    expect(probe).not.toHaveProperty("repo");
    expect(typeof probe?.mutate).toBe("function");
    expect(typeof probe?.detect).toBe("function");
    expect(probe).not.toHaveProperty("compiles");
  });

  it("carries a repo through when the list names one", () => {
    const list = readValid();
    const [spec] = list.probes;
    const [probe] = buildHarnessProbes({ probes: [{ ...spec!, repo: "docs" }] });
    expect(probe?.repo).toBe("docs");
  });

  it("applies each edit with substituteOnce only when the probe is mutated", () => {
    withWorkspace((folder) => {
      const file = join(folder, "target.txt");
      writeFileSync(file, "before and before\n");
      const edit = { file, find: "and", replace: "or" };
      const base = readValid().probes[0]!;
      const [probe] = buildHarnessProbes({ probes: [{ ...base, files: [file], edits: [edit] }] });
      expect(readFileSync(file, "utf8")).toBe("before and before\n");
      probe?.mutate();
      expect(readFileSync(file, "utf8")).toBe("before or before\n");
      expect(() => probe?.mutate()).toThrow(/mutation anchor not found/);
    });
  });

  it("reads the verdict through the shared detector with the list's command, args and reached", async () => {
    const base = readValid().probes[0]!;
    const detector = {
      command: "node",
      args: ["-e", "console.log('went boom'); process.exit(1)"],
      reached: "boom",
    };
    const [probe] = buildHarnessProbes({ probes: [{ ...base, detector }] });
    const verdict = await probe?.detect();
    expect(verdict?.refused).toBe(true);
    expect(verdict?.evidence).toContain("went boom");
  });
});
