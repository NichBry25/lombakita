/*
 * One call per import spelling, each reaching the same weak helper body.
 *
 * The gate resolves a callee through the type checker, so what it can see depends entirely on how
 * the helper was imported. These are the spellings; assertion-resolution.test.ts asserts that all
 * of them reach the weakness and that the standard library is left alone.
 */
import { plain } from "./helpers.mjs";
import { plain as underAnotherName } from "./helpers.mjs";
import { plain as viaReExport } from "./re-exported.mjs";
import { starred } from "./star.mjs";
import * as helpers from "./helpers.mjs";
import defaultArrow from "./helpers.mjs";
import { shadowed } from "./shadowed.mjs";

const local = (r) => r.status >= 400 && r.status < 500;

export const calls = {
  definedInThisFile: (r) => local(r),
  namedImport: (r) => plain(r),
  renamedOnImport: (r) => underAnotherName(r),
  reExported: (r) => viaReExport(r),
  starExported: (r) => starred(r),
  namespaceQualified: (r) => helpers.plain(r),
  defaultExportedArrow: (r) => defaultArrow(r),
  behindADeclarationFile: (r) => shadowed(r),
  standardLibrary: (r) => Object.keys(r).length === 2,
  pinsWhatItMeans: (r) => r.status === 403,
};
