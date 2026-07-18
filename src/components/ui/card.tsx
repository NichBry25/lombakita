import type { HTMLAttributes } from "react";
import { joinClassNames } from "./class-names";

type CardVariant = "surface" | "raised" | "inset";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  spacious?: boolean;
};

const VARIANT_CLASS_NAMES: Record<CardVariant, string> = {
  surface: "surface-card",
  raised: "raised-card",
  inset: "inset-panel",
};

export function Card({
  variant = "surface",
  spacious = false,
  className,
  ...cardProps
}: CardProps) {
  return (
    <div
      {...cardProps}
      className={joinClassNames(
        VARIANT_CLASS_NAMES[variant],
        spacious ? "card-padding-lg" : "card-padding",
        className,
      )}
    />
  );
}

export function CardHeader({ className, ...headerProps }: HTMLAttributes<HTMLDivElement>) {
  return <div {...headerProps} className={joinClassNames("stack-xs", className)} />;
}

export function CardTitle({ className, ...titleProps }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 {...titleProps} className={joinClassNames("section-title", className)} />;
}

export function CardDescription({
  className,
  ...descriptionProps
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...descriptionProps} className={joinClassNames("muted-copy", className)} />;
}

export function CardContent({ className, ...contentProps }: HTMLAttributes<HTMLDivElement>) {
  return <div {...contentProps} className={joinClassNames("stack-md", className)} />;
}
