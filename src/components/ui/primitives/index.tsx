"use client";

export { useModal } from "./modal-context";
export { useToast } from "./toast-context";
export type { ModalConfig, ModalAction } from "./modal-context";
export type { ToastConfig, ToastType } from "./toast-context";

import type { ReactNode } from "react";
import { ModalProvider } from "./modal-context";
import { Modal } from "./modal";
import { ToastProvider } from "./toast-context";
import { ToastContainer } from "./toast";

export function UIPrimitivesProvider({ children }: { children: ReactNode }) {
  return (
    <ModalProvider>
      <ToastProvider>
        {children}
        <Modal />
        <ToastContainer />
      </ToastProvider>
    </ModalProvider>
  );
}
