import type { HTMLAttributes, ReactNode } from "react";
import type { ResponsiveValue } from "../../theme/tokens";
import { cx } from "../../utils/cx";
import { resolveColumnsClass, type ColumnCount } from "../../utils/system";

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
  icon?: ReactNode;
}

export function Stat({ label, value, trend, icon, ...rest }: StatProps) {
  return (
    <div {...rest} className="glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-secondary">{label}</div>
        {icon ? <div className="text-accent">{icon}</div> : null}
      </div>
      <div className="mt-2 font-heading text-3xl font-semibold text-foreground">{value}</div>
      {trend ? <div className="mt-2 text-sm text-secondary">{trend}</div> : null}
    </div>
  );
}

export interface StatGridProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  columns?: ResponsiveValue<ColumnCount>;
}

export function StatGrid({ columns = { base: 1, sm: 2 }, children, ...rest }: StatGridProps) {
  return (
    <div {...rest} className={cx("grid gap-4", resolveColumnsClass(columns))}>
      {children}
    </div>
  );
}
