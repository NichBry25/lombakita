"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastType = "error" | "success" | "info";

export interface ToastConfig {
  message: string;
  type: ToastType;
  /** Milliseconds before a success or info toast dismisses itself. 0 keeps it. Ignored for error. */
  duration?: number;
}

export interface Toast extends ToastConfig {
  id: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (config: ToastConfig) => string;
  removeToast: (id: string) => void;
  pauseToast: (id: string) => void;
  resumeToast: (id: string) => void;
}

interface DismissTimer {
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

const DEFAULT_DISMISS_MS = 6000;
const MAX_VISIBLE_TOASTS = 3;

const ToastContext = createContext<ToastContextValue | null>(null);

function dismissDelayFor(config: ToastConfig): number {
  if (config.type === "error") return 0;
  return config.duration ?? DEFAULT_DISMISS_MS;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, DismissTimer>>(new Map());

  const dropToast = useCallback((id: string) => {
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const startTimer = useCallback(
    (id: string, timer: DismissTimer) => {
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => dropToast(id), timer.remainingMs);
    },
    [dropToast],
  );

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer?.handle) {
      clearTimeout(timer.handle);
    }
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pauseToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remainingMs -= Date.now() - timer.startedAt;
  }, []);

  const resumeToast = useCallback(
    (id: string) => {
      const timer = timersRef.current.get(id);
      if (!timer || timer.handle) return;
      startTimer(id, timer);
    },
    [startTimer],
  );

  const addToast = useCallback(
    (config: ToastConfig): string => {
      const id = crypto.randomUUID();
      const delayMs = dismissDelayFor(config);
      const nextToast: Toast = { ...config, id };
      setToasts((prev) => {
        const visible = [...prev, nextToast];
        const evicted = visible.slice(0, -MAX_VISIBLE_TOASTS);
        for (const old of evicted) {
          const oldTimer = timersRef.current.get(old.id);
          if (oldTimer?.handle) clearTimeout(oldTimer.handle);
          timersRef.current.delete(old.id);
        }
        return visible.slice(-MAX_VISIBLE_TOASTS);
      });
      if (delayMs > 0) {
        const timer: DismissTimer = { handle: null, remainingMs: delayMs, startedAt: 0 };
        timersRef.current.set(id, timer);
        startTimer(id, timer);
      }
      return id;
    },
    [startTimer],
  );

  // Strict Mode and Fast Refresh unmount the provider and mount it again with its toasts kept, so the
  // cleanup pauses every dismiss timer and the mount resumes them. After a real unmount no timer is
  // left to set state on a tree that is gone.
  useEffect(() => {
    const timers = timersRef.current;
    for (const [id, timer] of timers) {
      if (timer.handle === null) startTimer(id, timer);
    }
    return () => {
      for (const id of timers.keys()) pauseToast(id);
    };
  }, [startTimer, pauseToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, pauseToast, resumeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast(): Pick<ToastContextValue, "addToast" | "removeToast"> {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error(
      "useToast must be used inside <ToastProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return { addToast: ctx.addToast, removeToast: ctx.removeToast };
}

export function useToastState(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error(
      "useToastState must be used inside <ToastProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return ctx;
}
