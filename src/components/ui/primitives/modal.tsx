"use client";

import { useEffect, useId, useLayoutEffect, useRef, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  useModalState,
  type ModalAction,
  type ModalConfig,
  type ModalTaskResult,
} from "./modal-context";
import { Button } from "../button";
import { Feedback } from "../feedback";
import { MAIN_CONTENT_ID } from "../main-content-id";

// Elements that can hold keyboard focus inside the dialog. Used both to move focus in on open and to
// cycle focus at the dialog's edges (the focus trap).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const getFocusable = (container: HTMLElement | null): HTMLElement[] => {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
};

type MainAction = Extract<ModalAction, { variant: "primary" }>;
type SafeAction = Exclude<ModalAction, { variant: "primary" }>;

const isMainAction = (action: ModalAction): action is MainAction => action.variant === "primary";
const isSafeAction = (action: ModalAction): action is SafeAction => action.variant !== "primary";

type FooterLayout = "end" | "row" | "stack";

// Two safe choices next to a main action do not fit one row at 390 px, so they stack.
const footerLayoutFor = (safeCount: number): FooterLayout => {
  if (safeCount === 0) return "end";
  if (safeCount === 1) return "row";
  return "stack";
};

const initialFocusFor = (config: ModalConfig): NonNullable<ModalConfig["initialFocus"]> => {
  if (config.initialFocus) return config.initialFocus;
  if (config.formId) return "field";
  if (config.alert) return "safe";
  return "main";
};

// The element focus lands on when the pop-up opens, falling back to the dialog itself.
const focusTargetFor = (dialog: HTMLElement | null, config: ModalConfig): HTMLElement | null => {
  if (!dialog) return null;
  const wanted = initialFocusFor(config);
  if (wanted === "field") {
    const [firstFieldOrControl] = getFocusable(dialog.querySelector<HTMLElement>(".modal-body"));
    return firstFieldOrControl ?? dialog;
  }
  const wantedControl = dialog.querySelector<HTMLElement>(`[data-modal-focus="${wanted}"]`);
  if (wantedControl) return wantedControl;
  if (wanted === "safe")
    return dialog.querySelector<HTMLElement>('[data-modal-focus="main"]') ?? dialog;
  return dialog;
};

// The page behind a pop-up stops being reachable by keyboard and screen reader, and stops
// scrolling. Toasts stay live because a failure can surface while a pop-up is open.
function useInertPageBehind(isOpen: boolean, backdropRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!isOpen || !backdrop) return;

    const previousOverflow = document.body.style.overflow;
    const inertedSiblings: HTMLElement[] = [];

    for (const child of Array.from(document.body.children)) {
      const isLive = child === backdrop || child.matches(".toast-region");
      if (isLive || !(child instanceof HTMLElement) || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      inertedSiblings.push(child);
    }

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const sibling of inertedSiblings) sibling.removeAttribute("inert");
    };
  }, [isOpen, backdropRef]);
}

// A trigger that left the page (a success removed it) or cannot take focus hands focus to the
// element the skip link lands on, so the next Tab starts from the content instead of the top of
// the document.
const moveFocusToMainContent = () => {
  document.getElementById(MAIN_CONTENT_ID)?.focus();
};

const returnFocusTo = (trigger: HTMLElement | null) => {
  if (trigger?.isConnected) {
    trigger.focus();
    if (document.activeElement === trigger) return;
  }
  moveFocusToMainContent();
};

// Focus goes back to the control that opened the pop-up once the pop-up has closed.
function useReturnFocusAfterClose(isOpen: boolean) {
  const triggerRef = useRef<HTMLElement | null>(null);

  // A layout effect runs before every passive effect of the same commit, so the trigger is read
  // before the pop-up moves focus and before the page behind goes inert.
  useLayoutEffect(() => {
    if (isOpen) triggerRef.current = document.activeElement as HTMLElement | null;
  }, [isOpen]);

  // Call this hook after useInertPageBehind: cleanups run in call order, and the trigger cannot
  // take focus while the page behind it is still inert.
  useEffect(() => {
    if (!isOpen) return;
    return () => returnFocusTo(triggerRef.current);
  }, [isOpen]);
}

export function Modal() {
  const { config, closeModal, runTask, isPending, failureMessage } = useModalState();
  const titleId = useId();
  const bodyId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const isOpen = config !== null;

  const actions: ModalAction[] = config?.actions ?? [];
  const mainAction = actions.find(isMainAction);
  const safeActions = actions.filter(isSafeAction);

  const runMainAction = () => {
    if (!mainAction) return;
    const onClick = mainAction.onClick;
    void runTask(async (): Promise<ModalTaskResult> => onClick?.());
  };

  // The main button stays enabled while its action runs so it keeps focus, so a second press of a
  // submit button has to be stopped here. A button with an onClick is stopped by runTask.
  const stopSubmitWhilePending = (event: MouseEvent<HTMLButtonElement>) => {
    if (isPending) event.preventDefault();
  };

  const runSafeAction = (action: SafeAction) => {
    if (isPending) return;
    action.onClick?.();
    closeModal();
  };

  // Esc, and a tap outside a pop-up with no field, do the safe choice. A pop-up with only a main
  // action (Informasi) treats that one button as the way out. A pop-up with no actions carries its
  // own decisions in its body, so Esc just closes it.
  const doSafeChoice = () => {
    if (isPending) return;
    const [firstSafe] = safeActions;
    if (firstSafe) {
      runSafeAction(firstSafe);
      return;
    }
    if (mainAction) {
      runMainAction();
      return;
    }
    closeModal();
  };

  // Mirrored by an effect because refs must not be written while rendering, and the keydown
  // listener below is bound once per open.
  const doSafeChoiceRef = useRef(doSafeChoice);
  useEffect(() => {
    doSafeChoiceRef.current = doSafeChoice;
  });

  // Keyed on the config, so replacing one open pop-up with another moves focus again.
  useEffect(() => {
    if (!config) return;
    focusTargetFor(dialogRef.current, config)?.focus();
  }, [config]);

  useInertPageBehind(isOpen, backdropRef);
  useReturnFocusAfterClose(isOpen);

  // Trap Tab within the dialog and do the safe choice on Escape while open.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A control inside the pop-up that handled Escape itself, such as an open SelectField list,
        // has prevented its default, and that Escape is not also the pop-up's.
        if (event.defaultPrevented) return;
        event.preventDefault();
        doSafeChoiceRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusables = getFocusable(dialog);

      // Nothing focusable: keep focus on the dialog itself rather than letting Tab escape to the page.
      if (focusables.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const outside = !dialog?.contains(active);

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  if (!config || typeof document === "undefined") return null;

  const opensOutsideTapAsSafeChoice = !config.wide;
  const layout = footerLayoutFor(safeActions.length);
  const isFullHeight = config.fullHeight === true;
  const fullHeightName = config.fullHeight === true ? config.title : undefined;
  const sideEdge = config.fullHeight === true && config.drawer === true ? "end" : undefined;

  const safeButtons = safeActions.map((action, index) => (
    <Button
      key={action.label}
      variant="link"
      size="lg"
      className="modal-safe-action"
      aria-disabled={isPending || undefined}
      data-modal-focus={index === 0 ? "safe" : undefined}
      onClick={() => runSafeAction(action)}
    >
      {action.label}
    </Button>
  ));

  const mainButton = mainAction ? (
    <Button
      variant="primary"
      size="md"
      className="modal-main-action"
      loading={isPending}
      keepFocusWhileLoading
      data-modal-focus="main"
      fullWidth={layout === "stack"}
      {...(config.formId
        ? { type: "submit" as const, form: config.formId, onClick: stopSubmitWhilePending }
        : { onClick: runMainAction })}
    >
      {mainAction.label}
    </Button>
  ) : null;

  return createPortal(
    <div
      ref={backdropRef}
      role="presentation"
      className="modal-backdrop"
      data-height={isFullHeight ? "full" : undefined}
      data-side={sideEdge}
      onClick={opensOutsideTapAsSafeChoice ? doSafeChoice : undefined}
    >
      <div
        ref={dialogRef}
        role={config.alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={isFullHeight ? undefined : titleId}
        aria-label={isFullHeight ? fullHeightName : undefined}
        aria-describedby={isFullHeight ? undefined : bodyId}
        tabIndex={-1}
        className="modal-dialog"
        data-width={config.wide ? "wide" : "narrow"}
        data-height={isFullHeight ? "full" : undefined}
        data-side={sideEdge}
        onClick={(e) => e.stopPropagation()}
      >
        {isFullHeight ? (
          config.body
        ) : (
          <>
            <h2 id={titleId} className="modal-title">
              {config.title}
            </h2>
            <div id={bodyId} className="modal-body">
              {config.body}
            </div>
            {failureMessage ? (
              <Feedback tone="error" className="modal-failure">
                {failureMessage}
              </Feedback>
            ) : null}
            {actions.length > 0 ? (
              <div className="modal-footer" data-layout={layout}>
                {layout === "stack" ? mainButton : null}
                {safeButtons}
                {layout === "stack" ? null : mainButton}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
