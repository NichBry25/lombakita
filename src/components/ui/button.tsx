import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";
import { LinkPendingSlot } from "./link-pending";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
};

/**
 * While `loading` is set the button keeps its own label and takes the spinner into the
 * leading slot. The label is what tells the user which action is running, so it is never
 * swapped out for generic loading text, and the fixed slot keeps the button from resizing.
 */
export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  leadingIcon,
  className,
  children,
  disabled,
  type = "button",
  ...buttonProps
}: ButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={joinClassNames("ui-button", className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
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

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  // A localized accessible name is mandatory — an icon-only control is unnamed without it.
  label: string;
  icon: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

// Icon-only button for actions whose glyph is unambiguous (logout, delete, share, back).
// The glyph is decorative (aria-hidden via Icon); the button carries the accessible name.
// While loading the glyph is replaced by the spinner — the accessible name is unchanged, so
// the control keeps announcing what it does while `aria-busy` reports that it is running.
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
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
      aria-label={label}
      title={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading ? <Spinner size="sm" /> : <Icon name={icon} />}
    </button>
  );
}
