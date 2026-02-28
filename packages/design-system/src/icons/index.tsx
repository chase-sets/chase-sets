import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx";

export type IconName =
  | "search"
  | "cart"
  | "filter"
  | "dashboard"
  | "close"
  | "check"
  | "warning"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "menu"
  | "spark"
  | "package"
  | "settings"
  | "user"
  | "info";

type IconSize = "sm" | "md" | "lg";
type IconTone =
  | "primary"
  | "secondary"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "inverse";

const sizeClasses: Record<IconSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6"
};

const toneClasses: Record<IconTone, string> = {
  primary: "text-foreground",
  secondary: "text-secondary",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  inverse: "text-inverse"
};

function glyph(name: IconName): ReactNode {
  switch (name) {
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </>
      );
    case "cart":
      return (
        <>
          <circle cx="9" cy="19" r="1.5" />
          <circle cx="18" cy="19" r="1.5" />
          <path d="M3 4h2l2.6 10.5a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 8H7" />
        </>
      );
    case "filter":
      return <path d="M4 6h16M7 12h10M10 18h4" />;
    case "dashboard":
      return (
        <>
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="5" rx="1" />
          <rect x="13" y="11" width="7" height="9" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
        </>
      );
    case "close":
      return (
        <>
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </>
      );
    case "check":
      return <path d="M5 12l4.5 4.5L19 7" />;
    case "warning":
      return (
        <>
          <path d="M12 4l8 15H4L12 4z" />
          <path d="M12 9v4" />
          <circle cx="12" cy="16.5" r="0.5" fill="currentColor" stroke="none" />
        </>
      );
    case "chevronDown":
      return <path d="M6 9l6 6 6-6" />;
    case "chevronLeft":
      return <path d="M15 6l-6 6 6 6" />;
    case "chevronRight":
      return <path d="M9 6l6 6-6 6" />;
    case "menu":
      return (
        <>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </>
      );
    case "spark":
      return (
        <>
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z" />
        </>
      );
    case "package":
      return (
        <>
          <path d="M4 8l8-4 8 4-8 4-8-4z" />
          <path d="M4 8v8l8 4 8-4V8" />
          <path d="M12 12v8" />
        </>
      );
    case "settings":
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 0 0-.1-1l2.1-1.7-2-3.4-2.6 1a7.7 7.7 0 0 0-1.8-1L14.3 3h-4.6l-.3 2.9a7.7 7.7 0 0 0-1.8 1l-2.6-1-2 3.4 2.1 1.7a7 7 0 0 0 0 2L3 14.7l2 3.4 2.6-1a7.7 7.7 0 0 0 1.8 1l.3 2.9h4.6l.3-2.9a7.7 7.7 0 0 0 1.8-1l2.6 1 2-3.4-2.1-1.7c.1-.3.1-.7.1-1z" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v5" />
          <circle cx="12" cy="7.5" r="0.5" fill="currentColor" stroke="none" />
        </>
      );
    default:
      return null;
  }
}

export interface IconProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  name: IconName;
  size?: IconSize;
  tone?: IconTone;
  label?: string;
}

export function Icon({
  name,
  size = "md",
  tone = "primary",
  label,
  ...rest
}: IconProps) {
  const decorative = !label;

  return (
    <span
      {...rest}
      className={cx("inline-flex shrink-0 items-center", toneClasses[tone])}
    >
      <svg
        aria-hidden={decorative}
        aria-label={label}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={sizeClasses[size]}
      >
        {glyph(name)}
      </svg>
    </span>
  );
}
