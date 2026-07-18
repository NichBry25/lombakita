import type { SVGProps } from "react";
import { joinClassNames } from "./class-names";

export type IconName =
  | "arrow-right"
  | "bookmark"
  | "building"
  | "calendar"
  | "check"
  | "chevron-down"
  | "close"
  | "inbox"
  | "menu"
  | "moon"
  | "pin"
  | "search"
  | "sun"
  | "trophy"
  | "user"
  | "users";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  size?: "sm" | "md" | "lg" | "xl";
};

function IconPaths({ name }: { name: IconName }) {
  switch (name) {
    case "arrow-right":
      return (
        <>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </>
      );
    case "bookmark":
      return (
        <path d="M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-3.75L6 21Z" />
      );
    case "building":
      return (
        <>
          <path d="M4 21V5l8-3 8 3v16" />
          <path d="M2 21h20M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M10 21v-3h4v3" />
        </>
      );
    case "calendar":
      return (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 10h18" />
        </>
      );
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron-down":
      return <path d="m6 9 6 6 6-6" />;
    case "close":
      return (
        <>
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </>
      );
    case "inbox":
      return (
        <>
          <path d="M4 4h16v15H4Z" />
          <path d="M4 14h4l2 3h4l2-3h4" />
        </>
      );
    case "menu":
      return (
        <>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </>
      );
    case "moon":
      return <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />;
    case "pin":
      return (
        <>
          <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
          <circle cx="12" cy="10" r="2.5" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </>
      );
    case "sun":
      return (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </>
      );
    case "trophy":
      return (
        <>
          <path d="M8 4h8v4a4 4 0 0 1-8 0Z" />
          <path d="M12 12v5M8 21h8M10 17h4M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
        </>
      );
    case "users":
      return (
        <>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.5a3.5 3.5 0 0 1 0 7M17 14a6 6 0 0 1 4.5 6" />
        </>
      );
  }
}

export function Icon({ name, size = "md", className, ...svgProps }: IconProps) {
  return (
    <svg
      {...svgProps}
      className={joinClassNames("ui-icon", className)}
      data-size={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={svgProps["aria-label"] ? undefined : true}
    >
      <IconPaths name={name} />
    </svg>
  );
}
