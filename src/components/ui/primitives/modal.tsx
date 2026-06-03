"use client";

import { useModalState } from "./modal-context";

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
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={closeable ? closeModal : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: "1.5rem",
          minWidth: 320,
          maxWidth: "90vw",
          boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 id="modal-title" style={{ margin: 0, fontSize: "1.125rem" }}>
            {config.title}
          </h2>
          {closeable && (
            <button
              aria-label="Tutup"
              onClick={closeModal}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.25rem", lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>
        <div style={{ marginBottom: "1.25rem" }}>{config.body}</div>
        {config.actions.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            {config.actions.map((action, i) => (
              <button
                key={i}
                onClick={() => handleAction(action)}
                data-variant={action.variant ?? "secondary"}
                style={{
                  padding: "0.4rem 1rem",
                  borderRadius: 4,
                  border: "1px solid #ccc",
                  cursor: "pointer",
                  background:
                    action.variant === "primary"
                      ? "#355795"
                      : action.variant === "danger"
                        ? "#c0392b"
                        : "#f5f5f5",
                  color: action.variant === "primary" || action.variant === "danger" ? "#fff" : "#111",
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
