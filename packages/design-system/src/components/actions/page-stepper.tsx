import type { CSSProperties, HTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";

export interface PageStepperItem {
  label: string;
  description?: string;
  status: "complete" | "current" | "upcoming" | "blocked";
}

export interface PageStepperProps extends Omit<HTMLAttributes<HTMLOListElement>, "className" | "style"> {
  items: PageStepperItem[];
  variant?: "default" | "compact";
  orientation?: "horizontal" | "vertical" | "responsive";
  stickyCurrent?: boolean;
}

export function PageStepper({
  items,
  variant = "default",
  orientation = "responsive",
  stickyCurrent = false,
  ...rest
}: PageStepperProps) {
  const compact = variant === "compact";
  // ds-dynamic-css-var: allow --step-count for per-instance grid columns in the future DS scanner, issue 1719.
  const stepCountStyle = { "--step-count": items.length } as CSSProperties;

  return (
    <ol
      {...rest}
      className={cx(
        "grid gap-2",
        orientation === "horizontal" && "grid-cols-1 md:grid-cols-[repeat(var(--step-count),minmax(0,1fr))]",
        orientation === "vertical" && "grid-cols-1",
        orientation === "responsive" && "grid-cols-1 md:grid-cols-[repeat(var(--step-count),minmax(0,1fr))]",
      )}
      style={stepCountStyle}
    >
      {items.map((item, index) => (
        <li
          key={`${item.label}-${index}`}
          aria-current={item.status === "current" ? "step" : undefined}
          aria-disabled={item.status === "upcoming" ? true : undefined}
          className={cx(
            "rounded-tokenMd border shadow-tokenSm",
            compact ? "p-3" : "p-4",
            stickyCurrent && item.status === "current" && "sticky top-20 z-10",
            item.status === "complete" && "border-success bg-elevated",
            item.status === "current" && "border-accent bg-elevated",
            item.status === "upcoming" && "border-muted bg-background",
            item.status === "blocked" && "border-danger bg-elevated",
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cx(
                "inline-flex shrink-0 items-center justify-center rounded-tokenFull text-xs font-bold",
                compact ? "h-7 w-7" : "h-8 w-8",
                item.status === "complete" && "bg-success text-success-contrast",
                item.status === "current" && "bg-accent text-accent-contrast",
                item.status === "upcoming" && "bg-muted text-secondary",
                item.status === "blocked" && "bg-danger text-danger-contrast",
              )}
            >
              {item.status === "complete" ? (
                <Icon name="check" size="sm" />
              ) : item.status === "blocked" ? (
                <Icon name="warning" size="sm" />
              ) : (
                index + 1
              )}
            </span>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{item.label}</div>
              {item.description && !compact ? <div className="text-xs text-secondary">{item.description}</div> : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
