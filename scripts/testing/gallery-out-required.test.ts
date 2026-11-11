// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

describe("the four-width gallery run", () => {
  it("refuses a width run without GALLERY_OUT before opening a browser", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GALLERY_WIDTHS: "1440x900",
      CHROME_PATH: "/nonexistent/chrome-for-the-gallery-guard-test",
    };
    delete env.GALLERY_OUT;
    delete env.GALLERY_DRY_RUN;
    const result = spawnSync(process.execPath, ["scripts/testing/gallery.mjs"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GALLERY_WIDTHS needs GALLERY_OUT");
  });
});
