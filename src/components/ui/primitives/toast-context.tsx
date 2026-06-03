"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export type ToastType = "error" | "success" | "info" | "warning";

export interface ToastConfig {
  message: string;
  type: ToastType;
  duration?: number;
}

export interface Toast extends ToastConfig {
  id: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (config: ToastConfig) => string;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (config: ToastConfig): string => {
      const id = crypto.randomUUID();
      const duration = config.duration ?? 5000;
      setToasts((prev) => [...prev, { ...config, id }]);
      if (duration > 0) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
        timersRef.current.set(id, handle);
      }
      return id;
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast(): Pick<ToastContextValue, "addToast" | "removeToast"> {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider> (part of <UIPrimitivesProvider>)");
  }
  return { addToast: ctx.addToast, removeToast: ctx.removeToast };
}

export function useToastState(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToastState must be used inside <ToastProvider> (part of <UIPrimitivesProvider>)");
  }
  return ctx;
}
