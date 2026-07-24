import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
};

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
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {leadingIcon}
      <span>{loading ? "Memuat…" : children}</span>
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
};

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
      {leadingIcon}
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
      aria-label={label}
      title={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      <Icon name={icon} />
    </button>
  );
}
