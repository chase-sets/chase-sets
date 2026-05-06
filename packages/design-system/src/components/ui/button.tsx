import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantClasses: Record<ButtonVariant, string> = {
  default: "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[var(--shadow-sm)] hover:bg-[var(--primary-hover)] hover:shadow-[var(--shadow-md)]",
  secondary: "border border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)] shadow-[var(--shadow-sm)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)]",
  outline: "border border-[var(--muted)] bg-[color-mix(in_srgb,var(--card)_72%,transparent)] text-[var(--foreground)] shadow-[var(--shadow-sm)] hover:border-[var(--primary)] hover:bg-[var(--secondary)]",
  ghost: "bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
  destructive: "bg-[var(--destructive)] text-[var(--destructive-foreground)] shadow-[var(--shadow-sm)] hover:bg-[color-mix(in_srgb,var(--destructive)_82%,black)]"
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 rounded-[calc(var(--radius)-2px)] px-3 text-sm",
  md: "h-10 gap-2 rounded-[var(--radius)] px-4 text-sm",
  lg: "h-11 gap-2 rounded-[calc(var(--radius)+2px)] px-5 text-base",
  icon: "h-10 w-10 rounded-[var(--radius)] p-0"
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "md",
    type = "button",
    loading = false,
    disabled,
    children,
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "ds-focus inline-flex shrink-0 items-center justify-center whitespace-nowrap font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] disabled:opacity-100",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
