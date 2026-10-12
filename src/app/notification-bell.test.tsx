import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { NotificationBell } from "./notification-bell";

vi.mock("@/components/ui", () => ({ Icon: () => null }));
const sessionHook = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ useSession: sessionHook }));

const authenticatedSession = (): Session => ({
  user: { id: "candidate", role: "candidate", verifiedRoles: ["candidate"] },
  expires: "2099-01-01T00:00:00.000Z",
});

beforeEach(() => {
  sessionHook.mockReturnValue({ data: authenticatedSession(), status: "authenticated" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("notification bell polling", () => {
  it.each([401, 403])("resumes after %s when the session refreshes without remounting", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce({ status, ok: false }).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ unreadCount: 2 }),
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<NotificationBell />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    sessionHook.mockReturnValue({ data: authenticatedSession(), status: "authenticated" });
    await act(async () => {
      view.rerender(<NotificationBell />);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.getByLabelText("Kotak masuk, 2 belum dibaca")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
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
