import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalProvider, useModal, useModalState } from "./modal-context";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ModalProvider>{children}</ModalProvider>
);

describe("useModal — provider guard", () => {
  it("throws a descriptive error when called outside ModalProvider", () => {
    expect(() => renderHook(() => useModal())).toThrow(
      "useModal must be used inside <ModalProvider>",
    );
  });
});

describe("useModal — openModal", () => {
  it("sets modal config state when openModal is called", () => {
    const { result } = renderHook(() => ({ modal: useModal(), state: useModalState() }), {
      wrapper,
    });

    expect(result.current.state.config).toBeNull();

    act(() => {
      result.current.modal.openModal({
        title: "Test",
        body: "Body",
        actions: [],
      });
    });

    expect(result.current.state.config?.title).toBe("Test");
  });

  it("replacing an open modal sets the new config", () => {
    const { result } = renderHook(() => ({ modal: useModal(), state: useModalState() }), {
      wrapper,
    });

    act(() => {
      result.current.modal.openModal({ title: "First", body: "B1", actions: [] });
    });
    act(() => {
      result.current.modal.openModal({ title: "Second", body: "B2", actions: [] });
    });

    expect(result.current.state.config?.title).toBe("Second");
  });
});

describe("useModal — closeModal", () => {
  it("clears modal config state when closeModal is called", () => {
    const { result } = renderHook(() => ({ modal: useModal(), state: useModalState() }), {
      wrapper,
    });

    act(() => {
      result.current.modal.openModal({ title: "T", body: "B", actions: [] });
    });
    expect(result.current.state.config).not.toBeNull();

    act(() => {
      result.current.modal.closeModal();
    });
    expect(result.current.state.config).toBeNull();
  });

  it("fires onClose when closeModal is called", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => ({ modal: useModal() }), { wrapper });

    act(() => {
      result.current.modal.openModal({ title: "T", body: "B", actions: [], onClose });
    });
    act(() => {
      result.current.modal.closeModal();
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not throw when closeModal is called with no modal open", () => {
    const { result } = renderHook(() => useModal(), { wrapper });
    expect(() => act(() => result.current.closeModal())).not.toThrow();
  });
});

describe("useModalState — runTask", () => {
  const openWithState = () => {
    const rendered = renderHook(() => ({ modal: useModal(), state: useModalState() }), {
      wrapper,
    });
    act(() => {
      rendered.result.current.modal.openModal({ title: "T", body: "B", actions: [] });
    });
    return rendered.result;
  };

  it("closes the modal when the task succeeds", async () => {
    const result = openWithState();

    await act(async () => {
      await result.current.state.runTask(async () => ({ ok: true }));
    });

    expect(result.current.state.config).toBeNull();
    expect(result.current.state.isPending).toBe(false);
  });

  it("closes the modal when the task returns nothing", async () => {
    const result = openWithState();

    await act(async () => {
      await result.current.state.runTask(() => undefined);
    });

    expect(result.current.state.config).toBeNull();
  });

  it("stays open and keeps the failure message when the task fails", async () => {
    const result = openWithState();

    await act(async () => {
      await result.current.state.runTask(async () => ({ ok: false, message: "Gagal." }));
    });

    expect(result.current.state.config).not.toBeNull();
    expect(result.current.state.failureMessage).toBe("Gagal.");
    expect(result.current.state.isPending).toBe(false);
  });

  it("shows a failure instead of closing when the task throws", async () => {
    const result = openWithState();

    await act(async () => {
      await result.current.state.runTask(async () => {
        throw new Error("network down");
      });
    });

    expect(result.current.state.config).not.toBeNull();
    expect(result.current.state.failureMessage).not.toBeNull();
  });

  it("clears the failure message when the task is tried again", async () => {
    const result = openWithState();

    await act(async () => {
      await result.current.state.runTask(async () => ({ ok: false, message: "Gagal." }));
    });
    await act(async () => {
      await result.current.state.runTask(async () => ({ ok: false, message: "Gagal lagi." }));
    });

    expect(result.current.state.failureMessage).toBe("Gagal lagi.");
  });

  it("ignores a second press while the first task is still running", async () => {
    const result = openWithState();
    const task = vi.fn(() => new Promise<void>(() => {}));

    act(() => {
      void result.current.state.runTask(task);
    });
    act(() => {
      void result.current.state.runTask(task);
    });

    expect(task).toHaveBeenCalledOnce();
    expect(result.current.state.isPending).toBe(true);
  });
});
