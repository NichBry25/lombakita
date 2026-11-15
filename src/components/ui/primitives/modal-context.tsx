"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";

// What a main action reports when it has finished. Returning nothing means it worked.
export type ModalOutcome = { ok: true } | { ok: false; message: string };

export type ModalTaskResult = ModalOutcome | void;

// An action is the main action (Utama, right of the footer) or a safe choice (a link, left of the
// footer). A main action may be async: the pop-up stays open and shows it is waiting until the task
// settles, then closes on success or shows the failure inside itself. A safe choice runs at once
// and closes the pop-up.
type MainModalAction = {
  label: string;
  variant: "primary";
  onClick?: () => ModalTaskResult | Promise<ModalTaskResult>;
};

type SafeModalAction = {
  label: string;
  variant?: "safe";
  onClick?: () => void;
};

export type ModalAction = MainModalAction | SafeModalAction;

// The main button of a form pop-up submits the form, so it cannot carry a click handler too.
type FormSubmitModalAction = {
  label: string;
  variant: "primary";
  onClick?: never;
};

type ModalConfigFields = {
  title: string;
  body: ReactNode;
  onClose?: () => void;
  // 560 wide instead of 480. Also means the pop-up holds a field or an image, so a tap outside
  // never closes it and typed text is not lost.
  wide?: boolean;
  // Rendered as role="alertdialog": destructive confirms and pop-ups that report a failure.
  alert?: boolean;
  // Where focus lands on open. Defaults to the first field when `formId` is set, the safe choice
  // for an `alert` (the main action when it has none), and the main action otherwise.
  initialFocus?: "safe" | "main" | "field";
};

// One main action and up to two safe choices. The first safe choice is what Esc and a tap
// outside do. A pop-up with only a main action (Informasi) uses that one instead. With a `formId`
// the main button submits that form from the footer, so the form itself lives in `body`.
export type ModalConfig = ModalConfigFields &
  (
    | { formId?: undefined; actions: ModalAction[] }
    | { formId: string; actions: Array<SafeModalAction | FormSubmitModalAction> }
  );

interface ModalContextValue {
  openModal: (config: ModalConfig) => void;
  closeModal: () => void;
  runTask: (task: () => ModalTaskResult | Promise<ModalTaskResult>) => Promise<void>;
  config: ModalConfig | null;
  isPending: boolean;
  failureMessage: string | null;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ModalConfig | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const configRef = useRef<ModalConfig | null>(null);
  const isPendingRef = useRef(false);

  const closeModal = useCallback(() => {
    const current = configRef.current;
    configRef.current = null;
    setConfig(null);
    setFailureMessage(null);
    current?.onClose?.();
  }, []);

  const openModal = useCallback((newConfig: ModalConfig) => {
    configRef.current = newConfig;
    setFailureMessage(null);
    setConfig(newConfig);
  }, []);

  const runTask = useCallback(
    async (task: () => ModalTaskResult | Promise<ModalTaskResult>) => {
      if (isPendingRef.current) return;
      isPendingRef.current = true;
      setIsPending(true);
      setFailureMessage(null);

      let outcome: ModalTaskResult;
      try {
        outcome = await task();
      } catch {
        outcome = { ok: false, message: NETWORK_ERROR_MESSAGE };
      }

      isPendingRef.current = false;
      setIsPending(false);

      if (outcome && !outcome.ok) {
        setFailureMessage(outcome.message);
        return;
      }
      closeModal();
    },
    [closeModal],
  );

  return (
    <ModalContext.Provider
      value={{ openModal, closeModal, runTask, config, isPending, failureMessage }}
    >
      {children}
    </ModalContext.Provider>
  );
}

export function useModal(): Pick<ModalContextValue, "openModal" | "closeModal"> {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error(
      "useModal must be used inside <ModalProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return { openModal: ctx.openModal, closeModal: ctx.closeModal };
}

// For a form inside a pop-up: hand the submit to the pop-up so it owns the waiting and failure
// states, and closes itself when the task succeeds.
export function useModalTask(): ModalContextValue["runTask"] {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error(
      "useModalTask must be used inside <ModalProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return ctx.runTask;
}

export function useModalState(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error(
      "useModalState must be used inside <ModalProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return ctx;
}
