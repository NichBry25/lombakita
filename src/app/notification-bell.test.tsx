import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

vi.mock("@/components/ui", () => ({ Icon: () => null }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("notification bell polling", () => {
  it.each([401, 403])("stops polling after %s", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ status, ok: false });
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      render(<NotificationBell />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the 25 second interval after success", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValue({ status: 200, ok: true, json: async () => ({ unreadCount: 0 }) });
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      render(<NotificationBell />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_999);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
