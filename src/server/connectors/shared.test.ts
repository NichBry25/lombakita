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

  it("does not retry by default, so a service that is genuinely down is reported promptly", async () => {
    const probe = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await runConnectorProbe({
      name: "test",
      configured: true,
      includeLiveChecks: true,
      probe,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.live).toBe("down");
  });

  it("recovers when a retried probe succeeds on the second attempt", async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("write CONNECT_TIMEOUT undefined:undefined"))
      .mockResolvedValueOnce(undefined);

    const result = await runConnectorProbe({
      name: "postgres",
      configured: true,
      includeLiveChecks: true,
      probe,
      retries: 1,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.live).toBe("up");
  });

  it("reports the recovery rather than hiding it, so a degrading connector stays visible", async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("write CONNECT_TIMEOUT undefined:undefined"))
      .mockResolvedValueOnce(undefined);

    const result = await runConnectorProbe({
      name: "postgres",
      configured: true,
      includeLiveChecks: true,
      probe,
      retries: 1,
    });

    expect(result.detail).toContain("recovered on attempt 2 of 2");
    expect(result.detail).toContain("CONNECT_TIMEOUT");
  });

  it("stays silent about attempts when the first probe succeeds", async () => {
    const result = await runConnectorProbe({
      name: "postgres",
      configured: true,
      includeLiveChecks: true,
      probe: async () => undefined,
      retries: 1,
    });

    expect(result).toEqual({ name: "postgres", configured: true, live: "up" });
  });

  it("still reports down when every retried attempt fails", async () => {
    const probe = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await runConnectorProbe({
      name: "postgres",
      configured: true,
      includeLiveChecks: true,
      probe,
      retries: 1,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.live).toBe("down");
    expect(result.detail).toContain("after 2 attempts");
  });
});
