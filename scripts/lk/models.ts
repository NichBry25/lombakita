/**
 * Reads the model table the controller dispatches from and answers two questions: which model is a
 * class, and which class and model does a job at a tier get.
 *
 * Run: node --import tsx scripts/lk/models.ts [--file <path>] --class <Heavy|Standard|Light> [--json]
 *      node --import tsx scripts/lk/models.ts [--file <path>] --job <job> --tier <1|2|3> [--json]
 *
 * The table is read strictly. A shape this file cannot classify is refused rather than skipped, so
 * a typo in a class name or a model id stops a dispatch instead of starting a session on a model
 * nobody chose. Every refusal is one line starting `LK REFUSED: ` and exits 1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

export const MODEL_CLASSES = ["Heavy", "Standard", "Light"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const JOBS = [
  "controller",
  "implement",
  "review",
  "merge-audit",
  "lookup",
  "close",
] as const;
export type Job = (typeof JOBS)[number];

export const TIERS = ["1", "2", "3", "any"] as const;
export type RowTier = (typeof TIERS)[number];
export type RequestedTier = Exclude<RowTier, "any">;

export const MODEL_ID_PATTERN = /^claude-[a-z0-9-]+$/;

const CLASS_TABLE_HEAD = ["| Class | Model |", "|---|---|"] as const;
const JOB_TABLE_HEAD = ["| Job | Tier | Class |", "|---|---|---|"] as const;

export interface JobRow {
  job: Job;
  tier: RowTier;
  class: ModelClass;
}

export interface ModelTable {
  models: Record<ModelClass, string>;
  jobs: readonly JobRow[];
}

/** Environment variables as the scripts read them: any name, a value that may be absent. */
export type Env = Readonly<Record<string, string | undefined>>;

export class LkRefusal extends Error {}

export function refuse(message: string): never {
  throw new LkRefusal(message);
}

const isModelClass = (value: string): value is ModelClass =>
  (MODEL_CLASSES as readonly string[]).includes(value);

const isJob = (value: string): value is Job => (JOBS as readonly string[]).includes(value);

const isRowTier = (value: string): value is RowTier => (TIERS as readonly string[]).includes(value);

export const isRequestedTier = (value: string): value is RequestedTier =>
  value === "1" || value === "2" || value === "3";

/** A parsed table row and the 1-based line it came from, so a refusal can name the line. */
interface TableRow {
  cells: string[];
  line: number;
}

const readTable = (lines: string[], head: readonly [string, string], file: string): TableRow[] => {
  const heads = lines.flatMap((text, index) => (text === head[0] ? [index] : []));
  const [start] = heads;
  if (start === undefined || heads.length !== 1) {
    refuse(`${file}: expected exactly one table headed "${head[0]}", found ${heads.length}`);
  }
  if (lines[start + 1] !== head[1]) {
    refuse(`${file} line ${start + 2}: expected the delimiter row "${head[1]}"`);
  }
  const columnCount = head[0].split("|").length - 2;
  const rows: TableRow[] = [];
  for (let index = start + 2; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (!text.startsWith("|")) break;
    if (!text.endsWith("|")) refuse(`${file} line ${index + 1}: row does not end with "|"`);
    const cells = text
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== columnCount) {
      refuse(`${file} line ${index + 1}: expected ${columnCount} cells, found ${cells.length}`);
    }
    rows.push({ cells, line: index + 1 });
  }
  return rows;
};

const readClassTable = (lines: string[], file: string): Record<ModelClass, string> => {
  const found = new Map<ModelClass, string>();
  for (const { cells, line } of readTable(lines, CLASS_TABLE_HEAD, file)) {
    const [name = "", model = ""] = cells;
    if (!isModelClass(name)) refuse(`${file} line ${line}: unknown class "${name}"`);
    if (!MODEL_ID_PATTERN.test(model)) {
      refuse(`${file} line ${line}: "${model}" is not a model id (${MODEL_ID_PATTERN.source})`);
    }
    if (found.has(name)) refuse(`${file} line ${line}: class ${name} is listed twice`);
    found.set(name, model);
  }
  const modelOf = (name: ModelClass): string => {
    const model = found.get(name);
    if (model === undefined) refuse(`${file}: class ${name} is missing from the Classes table`);
    return model;
  };
  return { Heavy: modelOf("Heavy"), Standard: modelOf("Standard"), Light: modelOf("Light") };
};

const readJobTable = (lines: string[], file: string): JobRow[] => {
  const rows: JobRow[] = [];
  for (const { cells, line } of readTable(lines, JOB_TABLE_HEAD, file)) {
    const [job = "", tier = "", name = ""] = cells;
    if (!isJob(job)) refuse(`${file} line ${line}: unknown job "${job}"`);
    if (!isRowTier(tier))
      refuse(`${file} line ${line}: tier must be 1, 2, 3 or any, not "${tier}"`);
    if (!isModelClass(name)) refuse(`${file} line ${line}: unknown class "${name}"`);
    if (rows.some((row) => row.job === job && row.tier === tier)) {
      refuse(`${file} line ${line}: job ${job} tier ${tier} is listed twice`);
    }
    rows.push({ job, tier, class: name });
  }
  return rows;
};

export const readModels = (path: string): ModelTable => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refuse(`cannot read the model table at ${path}`);
  }
  const lines = text.split("\n");
  return { models: readClassTable(lines, path), jobs: readJobTable(lines, path) };
};

export const modelForClass = (table: ModelTable, name: ModelClass): string => table.models[name];

/** A row for the exact tier wins over a row for tier `any`. */
export const resolveJob = (
  table: ModelTable,
  job: string,
  tier: RequestedTier,
): { class: ModelClass; model: string } => {
  const exact = table.jobs.find((row) => row.job === job && row.tier === tier);
  const anyTier = table.jobs.find((row) => row.job === job && row.tier === "any");
  const row = exact ?? anyTier;
  if (row === undefined) refuse(`no class for job ${job} tier ${tier}`);
  return { class: row.class, model: modelForClass(table, row.class) };
};

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** Strict option parsing: an unknown flag or a flag missing its value is a refusal. */
export const parseCliArgs = (
  args: string[],
  options: NonNullable<ParseArgsConfig["options"]>,
): { values: ParsedValues; positionals: string[] } => {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(reason.split("\n")[0] ?? reason);
  }
};

export const stringOption = (values: ParsedValues, name: string): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};

const main = (): void => {
  try {
    const { values, positionals } = parseCliArgs(process.argv.slice(2), {
      file: { type: "string" },
      class: { type: "string" },
      job: { type: "string" },
      tier: { type: "string" },
      json: { type: "boolean" },
    });
    if (positionals.length > 0) refuse(`unexpected argument "${positionals[0]}"`);
    const requestedClass = stringOption(values, "class");
    const job = stringOption(values, "job");
    const tier = stringOption(values, "tier");
    const asJson = values.json === true;
    const file = stringOption(values, "file") ?? join(process.cwd(), "docs/project/models.md");

    if (requestedClass !== undefined) {
      if (job !== undefined || tier !== undefined)
        refuse("give --class or --job with --tier, not both");
      if (!isModelClass(requestedClass)) refuse(`unknown class "${requestedClass}"`);
      const model = modelForClass(readModels(file), requestedClass);
      console.log(asJson ? JSON.stringify({ class: requestedClass, model }) : model);
      return;
    }
    if (job === undefined || tier === undefined) refuse("give --class, or --job with --tier");
    if (!isRequestedTier(tier)) refuse(`tier must be 1, 2 or 3, not "${tier}"`);
    const resolved = resolveJob(readModels(file), job, tier);
    console.log(
      asJson
        ? JSON.stringify({ job, tier, class: resolved.class, model: resolved.model })
        : `${resolved.class} ${resolved.model}`,
    );
  } catch (error) {
    if (!(error instanceof LkRefusal)) throw error;
    console.error(`LK REFUSED: ${error.message}`);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
