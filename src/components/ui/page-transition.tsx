"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Spinner } from "./spinner";

const DEFAULT_MESSAGE = "Memproses…";

/**
 * Failsafe for an action that resolves without ever navigating. The overlay blocks the whole
 * viewport, so it must never be able to strand the user; this is long enough that a slow but
 * succeeding navigation is never cut short.
 */
const STRANDED_OVERLAY_TIMEOUT_MS = 15000;

type RunAndNavigateOptions = {
  message?: string;
};

type PageTransitionContextValue = {
  begin: (message?: string) => void;
  end: () => void;
  /**
   * `action` must report whether it actually started a navigation. Returning false (a validation
   * failure, a rejected request, a save that stays put) dismisses the screen immediately.
   */
  runAndNavigate: (
    action: () => Promise<boolean>,
    options?: RunAndNavigateOptions,
  ) => Promise<void>;
};

const PageTransitionContext = createContext<PageTransitionContextValue | null>(null);

export function usePageTransition() {
  const context = useContext(PageTransitionContext);

  if (context === null) {
    throw new Error("usePageTransition must be used within PageTransitionProvider");
  }

  return context;
}

export function PageTransitionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const pathname = usePathname();

  const end = useCallback(() => {
    setMessage(null);
  }, []);

  const begin = useCallback((nextMessage: string = DEFAULT_MESSAGE) => {
    setMessage(nextMessage);
  }, []);

  /**
   * Runs a mutation that ends in a navigation. When the action does not navigate — it failed, or
   * it decided to stay on the page — the screen is dismissed so the caller can surface the error
   * where the user is still standing. When it does navigate the screen is deliberately left up:
   * the arriving route dismisses it, which keeps the transition continuous from click to painted
   * destination.
   */
  const runAndNavigate = useCallback(
    async (action: () => Promise<boolean>, options?: RunAndNavigateOptions): Promise<void> => {
      begin(options?.message);
      let navigating = false;

      try {
        navigating = await action();
      } finally {
        if (!navigating) {
          end();
        }
      }
    },
    [begin, end],
  );

  // A completed navigation is the overlay's success exit.
  useEffect(() => {
    setMessage(null);
  }, [pathname]);

  useEffect(() => {
    if (message === null) {
      return;
    }

    const timer = window.setTimeout(() => setMessage(null), STRANDED_OVERLAY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  const value = useMemo(() => ({ begin, end, runAndNavigate }), [begin, end, runAndNavigate]);

  return (
    <PageTransitionContext.Provider value={value}>
      {children}
      {message === null ? null : <PageTransitionOverlay message={message} />}
    </PageTransitionContext.Provider>
  );
}

function PageTransitionOverlay({ message }: { message: string }) {
  const panelRef = useRef<HTMLDivElement>(null);

  // The overlay covers the viewport, so the page underneath must stop being reachable by
  // keyboard and stop scrolling — being visually hidden is not the same as being gone.
  useEffect(() => {
    const overlay = panelRef.current?.parentElement ?? null;
    const previousOverflow = document.body.style.overflow;
    const inertedSiblings: HTMLElement[] = [];

    for (const child of Array.from(document.body.children)) {
      if (child === overlay || !(child instanceof HTMLElement) || child.hasAttribute("inert")) {
        continue;
      }

      child.setAttribute("inert", "");
      inertedSiblings.push(child);
    }

    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;

      for (const sibling of inertedSiblings) {
        sibling.removeAttribute("inert");
      }
    };
  }, []);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="page-transition">
      <div className="page-transition-panel" ref={panelRef} tabIndex={-1} role="status">
        <span className="brand-wordmark brand-wordmark-primary" aria-hidden="true" />
        <span className="brand-wordmark brand-wordmark-reversed" aria-hidden="true" />
        <Spinner size="lg" />
        <p className="page-transition-message">{message}</p>
      </div>
    </div>,
    document.body,
  );
}
