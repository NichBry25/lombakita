import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Raised from the 5s default. Several auth suites import the auth.config module graph from
    // inside the test body, so the first test in each of those files pays a cold Vite transform of
    // next-auth + the Drizzle adapter + the server auth modules. That import is ~5s on a loaded
    // machine and ~30ms once cached, which made exactly the first test of each file fail on a busy
    // runner while every later test in the same file passed. This changes only how long a test may
    // take before being declared failed — fast tests stay fast.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
