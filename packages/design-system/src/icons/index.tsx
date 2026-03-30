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
  | "chevronUp"
  | "chevronLeft"
  | "chevronRight"
  | "menu"
  | "spark"
  | "package"
  | "settings"
  | "user"
  | "info"
  | "star"
  | "starHalf"
  | "starEmpty"
  | "copy"
  | "plus"
  | "minus"
  | "edit"
  | "trash"
  | "heart"
  | "heartFilled"
  | "share"
  | "image"
  | "dollar"
  | "truck"
  | "clock"
  | "eye"
  | "eyeOff";

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
    case "chevronUp":
      return <path d="M6 15l6-6 6 6" />;
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
    case "star":
      return (
        <path
          d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
          fill="currentColor"
        />
      );
    case "starHalf":
      return (
        <>
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
          />
          <path
            d="M12 2v15.27L5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
            fill="currentColor"
          />
        </>
      );
    case "starEmpty":
      return (
        <path
          d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
        />
      );
    case "copy":
      return (
        <>
          <rect x="9" y="9" width="11" height="11" rx="1.5" />
          <path d="M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15" />
        </>
      );
    case "plus":
      return (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      );
    case "minus":
      return <path d="M5 12h14" />;
    case "edit":
      return (
        <>
          <path d="M17 3l4 4L7 21H3v-4L17 3z" />
        </>
      );
    case "trash":
      return (
        <>
          <path d="M4 7h16" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" />
          <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
        </>
      );
    case "heart":
      return (
        <path d="M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z" />
      );
    case "heartFilled":
      return (
        <path
          d="M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z"
          fill="currentColor"
        />
      );
    case "share":
      return (
        <>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.59 13.51l6.83 3.98" />
          <path d="M15.41 6.51l-6.82 3.98" />
        </>
      );
    case "image":
      return (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 15l-5-5L5 21" />
        </>
      );
    case "dollar":
      return (
        <>
          <path d="M12 2v20" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </>
      );
    case "truck":
      return (
        <>
          <path d="M1 3h15v13H1z" />
          <path d="M16 8h4l3 3v5h-7V8z" />
          <circle cx="5.5" cy="18.5" r="2.5" />
          <circle cx="18.5" cy="18.5" r="2.5" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </>
      );
    case "eye":
      return (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "eyeOff":
      return (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <path d="M1 1l22 22" />
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
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={sizeClasses[size]}
      >
        {glyph(name)}
      </svg>
    </span>
  );
}
