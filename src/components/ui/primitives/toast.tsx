"use client";

import { useToastState, type Toast, type ToastType } from "./toast-context";
import { Icon, type IconName } from "../icon";
import { IconButton } from "../button";

const TOAST_PRESENTATION: Record<ToastType, { label: string; icon: IconName }> = {
  success: { label: "Berhasil", icon: "check" },
  info: { label: "Info", icon: "info" },
  warning: { label: "Peringatan", icon: "alert-triangle" },
  error: { label: "Error", icon: "alert-circle" },
};

// Errors and warnings interrupt the screen reader; success and info wait for a pause.
// Each role already carries its own live-region politeness, so no aria-live is set.
function liveRoleFor(type: ToastType): "alert" | "status" {
  return type === "error" || type === "warning" ? "alert" : "status";
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const { label, icon } = TOAST_PRESENTATION[toast.type];

  return (
    <div role={liveRoleFor(toast.type)} data-toast-type={toast.type} className="toast-item">
      <span className="toast-icon">
        <Icon name={icon} />
      </span>
      <div className="toast-copy">
        <span className="toast-label">{label}</span>
        <p className="toast-message">{toast.message}</p>
      </div>
      <IconButton
        className="toast-close"
        icon="close"
        label="Tutup notifikasi"
        onClick={() => onRemove(toast.id)}
      />
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastState();

  if (toasts.length === 0) return null;

  return (
    <div role="region" aria-label="Notifikasi" className="toast-region">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}
