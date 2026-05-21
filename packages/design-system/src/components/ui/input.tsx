import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      type={type}
      className={cn(
        "ds-focus h-10 w-full rounded-[var(--radius)] border border-[var(--input)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] shadow-[inset_0_1px_0_var(--surface-line)] placeholder:text-[var(--muted-foreground)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
});
