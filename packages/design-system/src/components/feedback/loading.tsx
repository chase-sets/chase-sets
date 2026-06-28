import type { HTMLAttributes } from "react";
import { ProgressTrack } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { type Tone, toneToSemantic } from "./shared";

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
        className={cx("inline-flex animate-spin rounded-tokenFull border-2 border-muted border-t-accent", sizeClass)}
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export type ProgressBarTone = Tone;

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  value: number;
  max?: number;
  tone?: ProgressBarTone;
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
    <div {...rest} className="space-y-2">
      <ProgressTrack value={percentage} tone={toneToSemantic(tone)} />
      <div className="text-xs text-secondary">{formatLabel(percentage)}</div>
    </div>
  );
}

export type ProgressTone = Tone;

export interface ProgressProps {
  value: number;
  tone?: ProgressTone;
  label?: string;
}

export function Progress({ value, tone = "accent", label }: ProgressProps) {
  return <ProgressTrack value={value} tone={toneToSemantic(tone)} label={label} />;
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
