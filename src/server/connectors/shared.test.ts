// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { runConnectorProbe } from "@/server/connectors/shared";

describe("runConnectorProbe", () => {
  it("marks connector as skipped when not configured", async () => {
    const probe = vi.fn(async () => undefined);

    const result = await runConnectorProbe({
      name: "test",
      configured: false,
      includeLiveChecks: true,
      probe,
    });

    expect(result).toEqual({
      name: "test",
      configured: false,
      live: "skipped",
      detail: "not configured",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("marks connector as up when probe succeeds", async () => {
    const result = await runConnectorProbe({
      name: "test",
      configured: true,
      includeLiveChecks: true,
      probe: async () => undefined,
    });

    expect(result.live).toBe("up");
  });

  it("marks connector as down when probe fails", async () => {
    const result = await runConnectorProbe({
      name: "test",
      configured: true,
      includeLiveChecks: true,
      probe: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.live).toBe("down");
    expect(result.detail).toContain("connection refused");
  });
});
