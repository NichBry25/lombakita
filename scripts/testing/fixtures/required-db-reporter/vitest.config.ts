/*
 * The configuration the reporter's own tests run their fixtures under.
 *
 * IT SPREADS THE ROOT CONFIG RATHER THAN RESTATING IT, so the gate under test is the gate the app
 * runs: `vitest.config.ts` is imported and its plugin comes with it, and that plugin is the one that
 * appends the reporter where a CLI `--reporter` cannot reach (LAUNCH-D156). A fixture config that
 * named the reporter itself would keep passing after the plugin was deleted from the root, which is
 * the wiring these tests exist to pin.
 *
 * Only what a fixture cannot share is overridden. `include` is narrowed to this directory, so the
 * root `include` never collects a fixture — the files are `.fixture.ts` for the same reason. The
 * jsdom environment and its setup file are dropped because a fixture is arithmetic.
 */
import { defineConfig } from "vitest/config";
import rootConfig from "../../../../vitest.config";

export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    environment: "node",
    setupFiles: [],
    include: ["scripts/testing/fixtures/required-db-reporter/*.fixture.ts"],
  },
});
