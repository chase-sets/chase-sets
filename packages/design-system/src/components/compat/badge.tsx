import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "trust"
  | "deal"
  | "info";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-[var(--primary)] text-[var(--primary-foreground)]",
  secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)]",
  outline: "border border-[var(--border)] text-[var(--foreground)]",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-danger-soft text-danger",
  trust: "bg-trust-soft text-trust",
  deal: "bg-deal-soft text-deal",
  info: "bg-info-soft text-info",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex items-center rounded-tokenFull px-2.5 py-0.5 text-xs font-semibold leading-4",
        variantClasses[variant],
        className,
      )}
    />
  );
}
