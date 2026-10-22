/**
 * `npm run verify:hook-proof`: judges every mutation of the protect-file script against every row of
 * the protect table, exactly. Each mutation must apply, compile (bash -n and the python body), flip
 * the rows it declares and no others, and crash nothing. It exits 1 on any miss.
 *
 * The docs checkout is DENY_PROOF_DOCS_ROOT, or docs/ under the working directory. Where it holds no
 * corpus the run says so and exits 0, because there is nothing it could judge.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DISPATCHER_MUTATIONS,
  DISPATCHER_PATH,
  judgeDispatcherMutation,
  runDispatcherTests,
  type DispatcherMutation,
} from "./dispatch-mutations";
import { corpusAbsentNote, loadProtectCorpus } from "./protect-corpus";
import { proveMutation, type MutationSite, type MutationTarget } from "./protect-mutation-proof";
import {
  appliesHere,
  judgeMutation,
  mutationProblems,
  type ProtectMutation,
} from "./protect-mutations";
import { protectTableMismatches, type ProtectRow } from "./protect-table";

const PROTECT_TARGET: MutationTarget = {
  pathInRepo: ".claude/hooks/check-protected-file.sh",
  pythonHeredoc: true,
};
const ROW_CONCURRENCY = 4;

const duplicatedElements = (mutations: readonly ProtectMutation[]): string[] => {
  const elements = mutations.map((mutation) => mutation.element);
  return elements.filter((element, index) => elements.indexOf(element) !== index);
};

const provenBy = async (
  site: MutationSite,
  mutation: ProtectMutation,
  table: readonly ProtectRow[],
): Promise<string[]> => {
  const started = Date.now();
  const result = await proveMutation(
    site,
    PROTECT_TARGET,
    mutation.element,
    mutation.pattern,
    mutation.replacement,
    (file) => protectTableMismatches(file, table, ROW_CONCURRENCY),
  );
  const verdict = judgeMutation(mutation, table, result.observed);
  const problems = mutationProblems(result, verdict);
  console.log(
    `${problems.length === 0 ? "RED" : "FAIL"} ${mutation.element}: declared=${verdict.declared.length} flipped=${verdict.flipped.length} ms=${Date.now() - started}`,
  );
  for (const problem of problems) console.log(`    ${problem}`);
  return problems;
};

const dispatcherProblemsOf = async (
  site: MutationSite,
  docsRoot: string,
  mutation: DispatcherMutation,
  baseline: ReturnType<typeof runDispatcherTests>,
): Promise<string[]> => {
  const started = Date.now();
  const result = await proveMutation(
    site,
    { pathInRepo: mutation.path ?? DISPATCHER_PATH },
    mutation.element,
    mutation.pattern,
    mutation.replacement,
    (file) => runDispatcherTests(site.repoRoot, dirname(dirname(dirname(file))), docsRoot),
  );
  const verdict = judgeDispatcherMutation(mutation, baseline, result.observed);
  const problems = [
    ...(result.applied ? [] : ["the edit did not change the script"]),
    ...(verdict.declared.length === 0 ? ["declares no test"] : []),
    ...(verdict.missing.length > 0
      ? [`declared tests that stayed green: ${JSON.stringify(verdict.missing)}`]
      : []),
    ...(verdict.extra.length > 0
      ? [`tests that turned red without being declared: ${JSON.stringify(verdict.extra)}`]
      : []),
  ];
  console.log(
    `${problems.length === 0 ? "RED" : "FAIL"} ${mutation.element}: declared=${verdict.declared.length} red=${verdict.red.length} ms=${Date.now() - started}`,
  );
  for (const problem of problems) console.log(`    ${problem}`);
  return problems;
};

const proveDispatcherMutations = async (
  scratchFolder: string,
  docsRoot: string,
  selected: readonly DispatcherMutation[],
): Promise<number> => {
  if (selected.length === 0) return 0;
  const site = { repoRoot: process.cwd(), scratchFolder };
  const baselineTree = join(scratchFolder, "dispatcher-baseline");
  mkdirSync(baselineTree);
  const baseline = runDispatcherTests(site.repoRoot, baselineTree, docsRoot);
  const stillFailing = baseline.filter((test) => test.failed).map((test) => test.fullName);
  console.log(`dispatcher baseline: tests=${baseline.length} failing=${stillFailing.length}`);
  let failures = 0;
  for (const mutation of selected) {
    const problems = await dispatcherProblemsOf(site, docsRoot, mutation, baseline);
    if (problems.length > 0) failures += 1;
  }
  return failures;
};

/** `--only <text>[|<text>...]` limits a run to the mutations whose element holds one of the texts; a complete run takes no option. */
const onlyOption = (): string | undefined => {
  const at = process.argv.indexOf("--only");
  return at < 0 ? undefined : process.argv[at + 1];
};

const run = async (scratchFolder: string): Promise<number> => {
  const only = onlyOption();
  const isSelected = (element: string): boolean =>
    only === undefined || only.split("|").some((text) => element.includes(text));
  const docsRoot = process.env.DENY_PROOF_DOCS_ROOT ?? join(process.cwd(), "docs");
  const corpus = await loadProtectCorpus(docsRoot);
  if (corpus === undefined) {
    console.log(corpusAbsentNote(docsRoot));
    return 0;
  }
  const site = { repoRoot: docsRoot, scratchFolder };
  const applicable = corpus.mutations.filter(appliesHere).filter((m) => isSelected(m.element));
  const duplicates = duplicatedElements(corpus.mutations);
  for (const element of duplicates)
    console.log(`FAIL the element ${element} is named more than once`);
  let failures = duplicates.length;
  for (const mutation of applicable) {
    if (!corpus.table.some(mutation.flips)) {
      console.log(`FAIL ${mutation.element}: declares no row`);
      failures += 1;
      continue;
    }
    const problems = await provenBy(site, mutation, corpus.table);
    if (problems.length > 0) failures += 1;
  }
  failures += await proveDispatcherMutations(
    scratchFolder,
    docsRoot,
    DISPATCHER_MUTATIONS.filter((mutation) => isSelected(mutation.element)),
  );
  console.log(
    `mutations=${corpus.mutations.length} applicable=${applicable.length} rows=${corpus.table.length} dispatcherMutations=${DISPATCHER_MUTATIONS.length} failures=${failures}`,
  );
  return failures === 0 ? 0 : 1;
};

const main = async (): Promise<void> => {
  const scratchFolder = mkdtempSync(join(tmpdir(), "lk-hook-proof-"));
  const removeScratch = (): void => rmSync(scratchFolder, { recursive: true, force: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      removeScratch();
      process.exit(130);
    });
  }
  let status = 1;
  try {
    status = await run(scratchFolder);
  } finally {
    removeScratch();
  }
  if (existsSync(scratchFolder)) {
    console.log(`FAIL the scratch folder ${scratchFolder} survived its teardown`);
    status = 1;
  }
  process.exit(status);
};

void main();
