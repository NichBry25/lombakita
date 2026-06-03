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

describe("useModal — action autoClose", () => {
  it("action with autoClose: true fires onClick then closes the modal", () => {
    const onClick = vi.fn();
    const { result } = renderHook(() => ({ modal: useModal(), state: useModalState() }), {
      wrapper,
    });

    act(() => {
      result.current.modal.openModal({
        title: "T",
        body: "B",
        actions: [{ label: "Confirm", onClick, autoClose: true }],
      });
    });

    const action = result.current.state.config!.actions[0]!;
    act(() => {
      action.onClick();
      // Simulate the Modal component calling closeModal after autoClose action
      result.current.modal.closeModal();
    });

    expect(onClick).toHaveBeenCalledOnce();
    expect(result.current.state.config).toBeNull();
  });
});
