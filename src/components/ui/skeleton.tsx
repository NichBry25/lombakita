import type { HTMLAttributes } from "react";
import { joinClassNames } from "./class-names";

export type SkeletonVariant =
  | "text"
  | "title"
  | "eyebrow"
  | "avatar"
  | "media"
  | "button"
  | "chip"
  | "block";

export type SkeletonWidth = "full" | "wide" | "half" | "narrow";

type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  variant?: SkeletonVariant;
  width?: SkeletonWidth;
};

/**
 * A single placeholder block. Always decorative — the page-level skeleton carries the
 * `aria-busy` and the accessible name, so individual blocks stay out of the accessibility tree.
 */
export function Skeleton({ variant = "text", width, className, ...skeletonProps }: SkeletonProps) {
  return (
    <div
      {...skeletonProps}
      className={joinClassNames("skeleton", className)}
      data-variant={variant}
      data-width={width}
      aria-hidden="true"
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <Skeleton variant="media" />
      <Skeleton variant="title" />
      <div className="stack-xs">
        <Skeleton />
        <Skeleton />
        <Skeleton width="half" />
      </div>
    </div>
  );
}
