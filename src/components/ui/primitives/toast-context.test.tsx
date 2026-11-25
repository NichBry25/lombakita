import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, useToastState } from "./toast-context";
import { useEffect, type ReactNode } from "react";

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
      result.current.toast.addToast({ message: "B", type: "success" });
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
      id = result.current.toast.addToast({ message: "M", type: "success", duration: 5000 });
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

  it("clears every dismiss timer when the provider unmounts with a toast still showing", () => {
    const { result, unmount } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Bye", type: "success", duration: 3000 });
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a toast added on mount after its timeout under Strict Mode", () => {
    // The render option is what makes React run the mount effect twice. A StrictMode below the
    // first component does not.
    const { result } = renderHook(
      () => {
        const { addToast } = useToast();
        const state = useToastState();
        useEffect(() => {
          addToast({ message: "Halo", type: "success", duration: 3000 });
        }, [addToast]);
        return state;
      },
      { wrapper, reactStrictMode: true },
    );

    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });
});

describe("useToast — kinds and limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderToasts = () =>
    renderHook(() => ({ toast: useToast(), state: useToastState() }), { wrapper });

  it("dismisses a success toast after 6000 ms when no duration is given", () => {
    const { result } = renderToasts();

    act(() => {
      result.current.toast.addToast({ message: "Ok", type: "success" });
    });
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(result.current.state.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state.toasts).toHaveLength(0);
  });

  it("keeps an error toast until it is closed, even with a duration", () => {
    const { result } = renderToasts();

    act(() => {
      result.current.toast.addToast({ message: "Gagal", type: "error", duration: 1000 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.state.toasts).toHaveLength(1);
  });

  it("keeps at most 3 toasts and drops the oldest first", () => {
    const { result } = renderToasts();

    act(() => {
      for (const message of ["A", "B", "C", "D"]) {
        result.current.toast.addToast({ message, type: "info", duration: 0 });
      }
    });

    expect(result.current.state.toasts.map((t) => t.message)).toEqual(["B", "C", "D"]);
  });

  it("resumes a paused toast from where it stopped", () => {
    const { result } = renderToasts();
    let id!: string;

    act(() => {
      id = result.current.toast.addToast({ message: "Ok", type: "success" });
    });
    act(() => {
      vi.advanceTimersByTime(4000);
      result.current.state.pauseToast(id);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.state.toasts).toHaveLength(1);

    act(() => {
      result.current.state.resumeToast(id);
    });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.state.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state.toasts).toHaveLength(0);
  });
});
