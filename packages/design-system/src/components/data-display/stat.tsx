import type { HTMLAttributes, ReactNode } from "react";
import type { ResponsiveValue } from "../../theme/tokens";
import { cx } from "../../utils/cx";
import { resolveColumnsClass } from "../../utils/system";

export interface StatProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
}

export function Stat({
  label,
  value,
  trend,
  ...rest
}: StatProps) {
  return (
    <div
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
        {label}
      </div>
      <div className="mt-2 font-heading text-3xl font-semibold text-foreground">
        {value}
      </div>
      {trend ? <div className="mt-2 text-sm text-secondary">{trend}</div> : null}
    </div>
  );
}

export interface StatGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  columns?: ResponsiveValue<1 | 2 | 3 | 4>;
}

export function StatGrid({
  columns = { base: 1, sm: 2 },
  children,
  ...rest
}: StatGridProps) {
  return (
    <div
      {...rest}
      className={cx("grid gap-4", resolveColumnsClass(columns))}
    >
      {children}
    </div>
  );
}
