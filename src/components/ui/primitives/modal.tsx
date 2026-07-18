"use client";

import { useModalState } from "./modal-context";
import { Button } from "../button";
import { Icon } from "../icon";

export function Modal() {
  const { config, closeModal } = useModalState();

  if (!config) return null;

  const closeable = config.closeable !== false;

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="modal-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            {config.title}
          </h2>
          {closeable && (
            <button type="button" className="modal-close" aria-label="Tutup" onClick={closeModal}>
              <Icon name="close" size="md" />
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
