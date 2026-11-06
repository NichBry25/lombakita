/**
 * `npm run verify:pstack`: reads the installed pstack plugin, the config and the pairings of
 * docs/.claude/pstack, the settings file, the mode, the rule book and the agent and command files,
 * runs the seven checks of pstack-check.ts and prints one PASS or FAIL line per check.
 *
 * Exit 0 when every check passes, 1 when any check fails, 2 when it refuses to run. The home folder
 * is the real one and the product root is the working directory. It is not part of CI or /precheck,
 * because a CI machine has no installed plugin.
 */

import { homedir } from "node:os";
import {
  PstackRefusal,
  buildCheckInputs,
  countFailedChecks,
  exitCodeOf,
  formatRefusal,
  formatReport,
  readInputs,
  readInstalledPath,
  runChecks,
} from "./pstack-check";

const main = (): void => {
  try {
    const homeFolder = homedir();
    const installedPath = readInstalledPath(homeFolder);
    const rawInputs = readInputs(process.cwd());
    const inputs = buildCheckInputs(rawInputs, installedPath, homeFolder);
    const results = runChecks(inputs);
    for (const line of formatReport(results)) console.log(line);
    process.exitCode = exitCodeOf(countFailedChecks(results));
  } catch (error) {
    if (!(error instanceof PstackRefusal)) throw error;
    console.error(formatRefusal(error.message));
    process.exitCode = 2;
  }
};

main();
