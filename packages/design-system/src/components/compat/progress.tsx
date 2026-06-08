import { cn } from "../../lib/utils";

export type ProgressTone = "neutral" | "active" | "success" | "blocked";

export function Progress({
  value,
  tone = "active",
  className,
}: {
  value: number;
  tone?: ProgressTone;
  className?: string;
}) {
  return (
    <div
      className={cn("h-2 overflow-hidden rounded-full bg-[var(--muted)]", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          tone === "neutral" && "bg-[var(--muted-foreground)]",
          tone === "active" && "bg-[var(--primary)]",
          tone === "success" && "bg-[var(--success)]",
          tone === "blocked" && "bg-[var(--danger)]",
        )}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-[var(--radius)] bg-[var(--muted)]", className)} aria-hidden="true" />
  );
}
