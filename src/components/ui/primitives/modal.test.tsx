// @vitest-environment jsdom

import { render, screen, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModalProvider, useModal } from "./modal-context";
import { Modal } from "./modal";

// Renders the provider + the Modal surface, and exposes openModal to the test via a trigger button
// so focus restoration has a real trigger to return to.
function Harness({
  onReady,
}: {
  onReady: (open: ReturnType<typeof useModal>["openModal"]) => void;
}) {
  const { openModal } = useModal();
  return (
    <button type="button" data-testid="trigger" onClick={() => onReady(openModal)}>
      Open
    </button>
  );
}

function renderModal(): { openModal: ReturnType<typeof useModal>["openModal"] } {
  let captured: ReturnType<typeof useModal>["openModal"] | null = null;
  render(
    <ModalProvider>
      <Harness onReady={(open) => (captured = open)} />
      <Modal />
    </ModalProvider>,
  );
  // Click the trigger so it is the element focus should return to on close.
  const trigger = screen.getByTestId("trigger");
  act(() => trigger.focus());
  act(() => trigger.click());
  return { openModal: captured! };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

describe("Modal — accessibility", () => {
  it("moves focus into the dialog when it opens", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Konfirmasi",
        body: "Body",
        actions: [{ label: "OK", onClick: () => {} }],
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape when the modal is closeable", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Konfirmasi", body: "Body", actions: [] }));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores Escape when the modal is not closeable", () => {
    const { openModal } = renderModal();
    act(() => openModal({ title: "Wajib", body: "Body", actions: [], closeable: false }));

    press("Escape");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const { openModal } = renderModal();
    const trigger = screen.getByTestId("trigger");

    act(() => openModal({ title: "Konfirmasi", body: "Body", actions: [] }));
    expect(document.activeElement).not.toBe(trigger);

    press("Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps focus from the last focusable back to the first on Tab", () => {
    const { openModal } = renderModal();
    act(() =>
      openModal({
        title: "Konfirmasi",
        body: "Body",
        actions: [
          { label: "Batal", onClick: () => {} },
          { label: "Lanjut", onClick: () => {} },
        ],
      }),
    );

    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>("button");
    const last = focusables[focusables.length - 1]!;
    act(() => last.focus());
    expect(document.activeElement).toBe(last);

    press("Tab");
    // Focus wrapped back inside the dialog rather than escaping to the page.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });
});
