"use client";

import { useToastState, type Toast } from "./toast-context";
import { Icon } from "../icon";
import { formatDisplayToken } from "@/lib/text/capitalize";

const TYPE_LABELS: Record<string, string> = {
  error: "Error",
  success: "Berhasil",
  info: "Info",
  warning: "Peringatan",
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  return (
    <div role="alert" aria-live="polite" data-toast-type={toast.type} className="toast-item">
      <span className="toast-label">
        {TYPE_LABELS[toast.type] ?? formatDisplayToken(toast.type)}
      </span>
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Tutup notifikasi"
        onClick={() => onRemove(toast.id)}
      >
        <Icon name="close" size="sm" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastState();

  if (toasts.length === 0) return null;

  return (
    <div aria-label="Notifikasi" className="toast-region">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}
