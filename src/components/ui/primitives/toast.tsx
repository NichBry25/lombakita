"use client";

import { useRef, type FocusEvent } from "react";
import { useToastState, type Toast, type ToastType } from "./toast-context";
import { Icon, type IconName } from "../icon";
import { IconButton } from "../button";

const TOAST_ICONS: Record<ToastType, IconName> = {
  success: "check-circle",
  info: "info",
  error: "alert-circle",
};

// Errors interrupt the screen reader; success and info wait for a pause.
// Each role already carries its own live-region politeness, so no aria-live is set.
function liveRoleFor(type: ToastType): "alert" | "status" {
  return type === "error" ? "alert" : "status";
}

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}

// The timer runs only while the pointer is off the toast and focus is outside it.
function ToastItem({ toast, onRemove, onPause, onResume }: ToastItemProps) {
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);

  const syncTimer = () => {
    if (hoveredRef.current || focusedRef.current) {
      onPause(toast.id);
      return;
    }
    onResume(toast.id);
  };

  const handlePointerEnter = () => {
    hoveredRef.current = true;
    syncTimer();
  };

  const handlePointerLeave = () => {
    hoveredRef.current = false;
    syncTimer();
  };

  const handleFocus = () => {
    focusedRef.current = true;
    syncTimer();
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    focusedRef.current = false;
    syncTimer();
  };

  return (
    <div
      role={liveRoleFor(toast.type)}
      data-toast-type={toast.type}
      className="toast-item"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <Icon name={TOAST_ICONS[toast.type]} className="toast-icon" />
      <p className="toast-message">{toast.message}</p>
      <IconButton
        variant="plain"
        className="toast-close"
        icon="close"
        label="Tutup notifikasi"
        onClick={() => onRemove(toast.id)}
      />
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast, pauseToast, resumeToast } = useToastState();

  if (toasts.length === 0) return null;

  return (
    <div role="region" aria-label="Notifikasi" className="toast-region">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onRemove={removeToast}
          onPause={pauseToast}
          onResume={resumeToast}
        />
      ))}
    </div>
  );
}
