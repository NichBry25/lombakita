import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { joinClassNames } from "./class-names";

export type ButtonVariant = "primary" | "gold" | "outline" | "ghost" | "danger";
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
