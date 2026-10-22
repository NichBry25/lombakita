/**
 * The private corpus of the protect-file proof: the mutations of the hook script and the table's
 * known-limit rows. Both name or mirror the hook's source, so they live in the private docs repository
 * under docs/.claude/hooks/proof/ and are loaded from there at run time. Nothing from that folder is
 * imported statically, and a corpus file may carry type-only imports of this repository, which are
 * erased before the file runs.
 *
 * Where the folder is absent the callers skip, and say so: `corpusAbsentNote` is the line they print.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProtectMutation } from "./protect-mutations";
import {
  PROOF_KIT,
  tableWithRows,
  type ProofKit,
  type ProtectRow,
  type Spec,
} from "./protect-table";

export const PROOF_FOLDER_IN_DOCS = ".claude/hooks/proof";
const MUTATIONS_FILE = "mutations.ts";
const LIMITS_FILE = "limits.ts";
const OLD_PROTECT_SCRIPT_FILE = "old-protect-script.sh";
export const OLD_PROTECT_BLOB_ID = "972ad52eb7368a15e896bf8600ec3e147985ad96";

export interface ProtectCorpus {
  folder: string;
  mutations: readonly ProtectMutation[];
  /** The public table followed by the corpus's known-limit rows. */
  table: readonly ProtectRow[];
}

interface MutationsModule {
  buildMutations?: (kit: ProofKit) => readonly ProtectMutation[];
}

interface LimitsModule {
  buildLimitSpecs?: (kit: ProofKit) => Spec[];
}

export const corpusFolderOf = (docsRoot: string): string => join(docsRoot, PROOF_FOLDER_IN_DOCS);

export const corpusAbsentNote = (docsRoot: string): string =>
  `PROTECT CORPUS ABSENT: ${corpusFolderOf(docsRoot)} holds no ${MUTATIONS_FILE} and ${LIMITS_FILE}, so the mutations and the known-limit rows are not run here`;

const importModule = async <Module>(path: string): Promise<Module> =>
  (await import(/* @vite-ignore */ pathToFileURL(path).href)) as Module;

/** The corpus of a docs checkout, or undefined when the folder holds neither file. A half corpus is an error. */
export const loadProtectCorpus = async (docsRoot: string): Promise<ProtectCorpus | undefined> => {
  const folder = corpusFolderOf(docsRoot);
  const mutationsPath = join(folder, MUTATIONS_FILE);
  const limitsPath = join(folder, LIMITS_FILE);
  const present = [mutationsPath, limitsPath].filter((path) => existsSync(path));
  if (present.length === 0) return undefined;
  if (present.length === 1) {
    throw new Error(`${folder} holds only one of ${MUTATIONS_FILE} and ${LIMITS_FILE}`);
  }
  const { buildMutations } = await importModule<MutationsModule>(mutationsPath);
  const { buildLimitSpecs } = await importModule<LimitsModule>(limitsPath);
  if (buildMutations === undefined) throw new Error(`${mutationsPath} exports no buildMutations`);
  if (buildLimitSpecs === undefined) throw new Error(`${limitsPath} exports no buildLimitSpecs`);
  return {
    folder,
    mutations: buildMutations(PROOF_KIT),
    table: tableWithRows(buildLimitSpecs(PROOF_KIT)),
  };
};

export const gitBlobId = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/** The script the controller and unset answers are compared with; an edited copy is refused by blob id. */
export const readPinnedOldProtectScript = (docsRoot: string): Buffer => {
  const content = readFileSync(join(corpusFolderOf(docsRoot), OLD_PROTECT_SCRIPT_FILE));
  const found = gitBlobId(content);
  if (found !== OLD_PROTECT_BLOB_ID) {
    throw new Error(`the old protect script has blob id ${found}, expected ${OLD_PROTECT_BLOB_ID}`);
  }
  return content;
};
