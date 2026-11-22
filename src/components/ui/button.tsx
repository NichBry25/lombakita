"use client";

import Link from "next/link";
import {
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";
import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";
import { LinkPendingSlot } from "./link-pending";
import { Spinner } from "./spinner";

// primary is Utama, outline is Kedua, link is Tautan aksi.
export type ButtonVariant = "primary" | "outline" | "link";
export type ButtonSize = "sm" | "md" | "lg";

// outline is Garis, plain is Polos, fill is Isi.
export type IconButtonVariant = "outline" | "plain" | "fill";
// md is 44 px with a 20 px glyph, lg is 52 px with a 22 px glyph (outline only), back is the
// 48 px touch area with a 24 px glyph that every back arrow uses.
export type IconButtonSize = "md" | "lg" | "back";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  // While loading, report the button as unavailable with aria-disabled instead of the disabled
  // attribute, so keyboard focus stays on it. The caller must ignore presses while it waits.
  keepFocusWhileLoading?: boolean;
  leadingIcon?: ReactNode;
};

// Holds the width the button had before it started loading, so the spinner taking the leading
// slot never makes the button resize.
function useWidthLockedWhileLoading(loading: boolean) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restingWidthRef = useRef(0);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    if (loading) {
      button.style.minWidth = `${restingWidthRef.current}px`;
      return;
    }
    button.style.minWidth = "";
    restingWidthRef.current = button.offsetWidth;
  });

  return buttonRef;
}

/**
 * While `loading` is set the button keeps its own label and colours and takes the spinner into
 * the leading slot. The label is what tells the user which action is running, so it is never
 * swapped out for generic loading text.
 */
export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  keepFocusWhileLoading = false,
  leadingIcon,
  className,
  children,
  disabled,
  type = "button",
  ...buttonProps
}: ButtonProps) {
  const buttonRef = useWidthLockedWhileLoading(loading);
  const reportsUnavailableByAria = loading && keepFocusWhileLoading;

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type={type}
      className={joinClassNames("ui-button", className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      aria-disabled={reportsUnavailableByAria ? true : buttonProps["aria-disabled"]}
      disabled={disabled || (loading && !keepFocusWhileLoading)}
    >
      {loading ? <Spinner size={size === "lg" ? "md" : "sm"} /> : leadingIcon}
      <span>{children}</span>
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
};

/**
 * A navigating button. It has no `loading` prop because it owns no action to await — the
 * pending state is the navigation itself, which `LinkPendingSlot` reads from the Link.
 */
export function ButtonLink({
  variant = "primary",
  size = "md",
  fullWidth = false,
  leadingIcon,
  className,
  children,
  ...linkProps
}: ButtonLinkProps) {
  return (
    <Link
      {...linkProps}
      className={joinClassNames("ui-button", className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
    >
      <LinkPendingSlot leadingIcon={leadingIcon} />
      <span>{children}</span>
    </Link>
  );
}

type IconButtonLinkProps = ComponentProps<typeof Link> & {
  // A localized accessible name is mandatory — an icon-only control is unnamed without it.
  label: string;
  icon: IconName;
  variant: IconButtonVariant;
  size?: IconButtonSize;
  // The tooltip shows the label unless the caller needs different words.
  tooltip?: string;
};

// The navigating counterpart of IconButton. Like ButtonLink it owns no action, so its pending
// state is the navigation itself and it takes no `loading` prop; LinkPendingSlot swaps the glyph
// for a spinner while the route loads. The accessible name stays put throughout.
export function IconButtonLink({
  label,
  icon,
  variant,
  size = "md",
  tooltip,
  className,
  ...linkProps
}: IconButtonLinkProps) {
  return (
    <Link
      {...linkProps}
      className={joinClassNames("ui-icon-button", className)}
      data-variant={variant}
      data-size={size}
      data-tooltip={tooltip ?? label}
      aria-label={label}
    >
      <LinkPendingSlot leadingIcon={<Icon name={icon} />} />
    </Link>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  // A localized accessible name is mandatory — an icon-only control is unnamed without it.
  label: string;
  icon: IconName;
  variant: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  // The tooltip shows the label unless the caller needs different words (a toggle, a short form).
  tooltip?: string;
};

// Icon-only button for actions whose glyph is unambiguous (close, delete, back, add).
// The glyph is decorative (aria-hidden via Icon); the button carries the accessible name.
// While loading the glyph is replaced by the spinner — the accessible name is unchanged, so
// the control keeps announcing what it does while `aria-busy` reports that it is running.
export function IconButton({
  label,
  icon,
  variant,
  size = "md",
  loading = false,
  tooltip,
  className,
  disabled,
  type = "button",
  ...buttonProps
}: IconButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={joinClassNames("ui-icon-button", className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      data-tooltip={tooltip ?? label}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading ? <Spinner size="sm" /> : <Icon name={icon} />}
    </button>
  );
}
