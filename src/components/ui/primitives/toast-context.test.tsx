import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, useToastState } from "./toast-context";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

describe("useToast — provider guard", () => {
  it("throws a descriptive error when called outside ToastProvider", () => {
    expect(() => renderHook(() => useToast())).toThrow(
      "useToast must be used inside <ToastProvider>",
    );
  });
});

describe("useToast — addToast", () => {
  it("appends a toast to the list", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    act(() => {
      result.current.toast.addToast({ message: "Hello", type: "info" });
    });

    expect(result.current.state.toasts).toHaveLength(1);
    expect(result.current.state.toasts[0]!.message).toBe("Hello");
    expect(result.current.state.toasts[0]!.type).toBe("info");
  });

  it("returns a string id", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let id!: string;
    act(() => {
      id = result.current.addToast({ message: "M", type: "success" });
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("stacks multiple toasts", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    act(() => {
      result.current.toast.addToast({ message: "A", type: "error" });
      result.current.toast.addToast({ message: "B", type: "warning" });
    });

    expect(result.current.state.toasts).toHaveLength(2);
  });
});

describe("useToast — removeToast", () => {
  it("removes the toast with the given id", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    let id!: string;
    act(() => {
      id = result.current.toast.addToast({ message: "X", type: "info", duration: 0 });
    });
    expect(result.current.state.toasts).toHaveLength(1);

    act(() => {
      result.current.toast.removeToast(id);
    });
    expect(result.current.state.toasts).toHaveLength(0);
  });

  it("does not remove other toasts when one is removed", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    let id1!: string;
    act(() => {
      id1 = result.current.toast.addToast({ message: "A", type: "error", duration: 0 });
      result.current.toast.addToast({ message: "B", type: "info", duration: 0 });
    });

    act(() => {
      result.current.toast.removeToast(id1);
    });

    expect(result.current.state.toasts).toHaveLength(1);
    expect(result.current.state.toasts[0]!.message).toBe("B");
  });
});

describe("useToast — auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the toast after duration ms", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    act(() => {
      result.current.toast.addToast({ message: "Bye", type: "success", duration: 3000 });
    });
    expect(result.current.state.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.state.toasts).toHaveLength(0);
  });

  it("does not auto-dismiss when duration is 0", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    act(() => {
      result.current.toast.addToast({ message: "Stays", type: "info", duration: 0 });
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.state.toasts).toHaveLength(1);
  });

  it("clears the auto-dismiss timer when toast is manually removed", () => {
    const { result } = renderHook(() => ({ toast: useToast(), state: useToastState() }), {
      wrapper,
    });

    let id!: string;
    act(() => {
      id = result.current.toast.addToast({ message: "M", type: "warning", duration: 5000 });
    });

    act(() => {
      result.current.toast.removeToast(id);
    });
    expect(result.current.state.toasts).toHaveLength(0);

    // Advancing time after manual removal should not error or resurface the toast
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(5000);
      }),
    ).not.toThrow();
    expect(result.current.state.toasts).toHaveLength(0);
  });
});
