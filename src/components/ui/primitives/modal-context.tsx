"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export interface ModalAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
  autoClose?: boolean;
}

export interface ModalConfig {
  title: string;
  body: ReactNode;
  actions: ModalAction[];
  onClose?: () => void;
  closeable?: boolean;
}

interface ModalContextValue {
  openModal: (config: ModalConfig) => void;
  closeModal: () => void;
  config: ModalConfig | null;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ModalConfig | null>(null);
  const configRef = useRef<ModalConfig | null>(null);

  const closeModal = useCallback(() => {
    const current = configRef.current;
    configRef.current = null;
    setConfig(null);
    current?.onClose?.();
  }, []);

  const openModal = useCallback((newConfig: ModalConfig) => {
    configRef.current = newConfig;
    setConfig(newConfig);
  }, []);

  return (
    <ModalContext.Provider value={{ openModal, closeModal, config }}>
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

export function useModalState(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error(
      "useModalState must be used inside <ModalProvider> (part of <UIPrimitivesProvider>)",
    );
  }
  return ctx;
}
