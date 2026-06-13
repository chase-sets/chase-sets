import type { HTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import type { Tone } from "./shared";

export interface LoadingSpinnerProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label?: string;
  size?: "sm" | "md" | "lg";
}

export function LoadingSpinner({ label = "Loading", size = "md", ...rest }: LoadingSpinnerProps) {
  const sizeClass = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8" : "h-6 w-6";

  return (
    <div {...rest} className="inline-flex items-center gap-2 text-secondary" role="status" aria-live="polite">
      <span
        aria-hidden="true"
        className={cx("inline-flex animate-spin rounded-full border-2 border-muted border-t-accent", sizeClass)}
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  value: number;
  max?: number;
  tone?: Tone | "active" | "blocked";
  formatLabel?: (percentage: number) => string;
}

export function ProgressBar({
  value,
  max = 100,
  tone = "accent",
  formatLabel = (p) => `${Math.round(p)}%`,
  ...rest
}: ProgressBarProps) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div
      {...rest}
      className="space-y-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
    >
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cx(
            "h-full rounded-full transition-all",
            tone === "accent" && "bg-accent",
            (tone === "neutral" || tone === "active") && "bg-secondary",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "danger" && "bg-danger",
            tone === "blocked" && "bg-danger",
            tone === "info" && "bg-info",
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="text-xs text-secondary">{formatLabel(percentage)}</div>
    </div>
  );
}

export interface SkeletonProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  height?: "sm" | "md" | "lg";
}

export function Skeleton({ height = "md", ...rest }: SkeletonProps) {
  const heightClass = height === "sm" ? "h-4" : height === "lg" ? "h-24" : "h-12";

  return (
    <div {...rest} aria-hidden="true" className={cx("w-full animate-pulse rounded-tokenMd bg-muted", heightClass)} />
  );
}
