"use client";

import { useEffect, useRef } from "react";
import { useModalState } from "./modal-context";
import { Button } from "../button";
import { Icon } from "../icon";

// Elements that can hold keyboard focus inside the dialog. Used both to move focus in on open and to
// cycle focus at the dialog's edges (the focus trap).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const getFocusable = (container: HTMLElement | null): HTMLElement[] => {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
};

export function Modal() {
  const { config, closeModal } = useModalState();

  const dialogRef = useRef<HTMLDivElement>(null);
  // The element that had focus before the dialog opened, so focus can return to it on close.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const isOpen = config !== null;
  const closeable = config?.closeable !== false;

  // Move focus into the dialog on open and return it to the trigger on close. Keyed on open/closed
  // only: replacing one open modal with another keeps the same saved trigger and does not re-run.
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    const [firstFocusable] = getFocusable(dialog);
    (firstFocusable ?? dialog)?.focus();

    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  // Trap Tab within the dialog and close on Escape while open. Re-binds when `closeable` changes so
  // Escape respects a non-closeable modal. `closeModal` is stable (useCallback in the provider).
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (closeable) {
          event.preventDefault();
          closeModal();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusables = getFocusable(dialog);

      // Nothing focusable: keep focus on the dialog itself rather than letting Tab escape to the page.
      if (focusables.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const outside = !dialog?.contains(active);

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, closeable, closeModal]);

  if (!config) return null;

  function handleAction(action: { onClick: () => void; autoClose?: boolean }) {
    action.onClick();
    if (action.autoClose !== false) {
      // closeModal fires onClose internally
      closeModal();
    }
  }

  return (
    <div
      role="presentation"
      className="modal-backdrop"
      onClick={closeable ? closeModal : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="modal-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            {config.title}
          </h2>
          {closeable && (
            <button type="button" className="modal-close" aria-label="Tutup" onClick={closeModal}>
              <Icon name="close" size="sm" />
            </button>
          )}
        </div>
        <div className="modal-body">{config.body}</div>
        {config.actions.length > 0 && (
          <div className="modal-actions">
            {config.actions.map((action, i) => (
              <Button
                key={i}
                variant={
                  action.variant === "primary"
                    ? "primary"
                    : action.variant === "danger"
                      ? "danger"
                      : "outline"
                }
                size="sm"
                onClick={() => handleAction(action)}
                data-variant={action.variant ?? "secondary"}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
