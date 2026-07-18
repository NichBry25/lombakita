import type { HTMLAttributes } from "react";
import { joinClassNames } from "./class-names";

export type SkeletonVariant = "text" | "title" | "avatar" | "media";

type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  variant?: SkeletonVariant;
};

export function Skeleton({ variant = "text", className, ...skeletonProps }: SkeletonProps) {
  return (
    <div
      {...skeletonProps}
      className={joinClassNames("skeleton", className)}
      data-variant={variant}
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
        <Skeleton />
      </div>
    </div>
  );
}
