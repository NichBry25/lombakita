"use client";

import { useToastState, type Toast } from "./toast-context";

const TYPE_LABELS: Record<string, string> = {
  error: "Error",
  success: "Berhasil",
  info: "Info",
  warning: "Peringatan",
};

const TYPE_COLORS: Record<string, string> = {
  error: "#c0392b",
  success: "#27ae60",
  info: "#2980b9",
  warning: "#d68910",
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      data-toast-type={toast.type}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.5rem",
        background: "#fff",
        border: `2px solid ${TYPE_COLORS[toast.type] ?? "#ccc"}`,
        borderRadius: 6,
        padding: "0.75rem 1rem",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        minWidth: 240,
        maxWidth: 360,
      }}
    >
      <span
        style={{
          fontWeight: 700,
          color: TYPE_COLORS[toast.type] ?? "#333",
          fontSize: "0.8rem",
          textTransform: "uppercase",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {TYPE_LABELS[toast.type] ?? toast.type}
      </span>
      <span style={{ flex: 1, fontSize: "0.9rem", color: "#111" }}>{toast.message}</span>
      <button
        aria-label="Tutup notifikasi"
        onClick={() => onRemove(toast.id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#666",
          fontSize: "1rem",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastState();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-label="Notifikasi"
      style={{
        position: "fixed",
        bottom: "1.5rem",
        right: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        zIndex: 1100,
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}
