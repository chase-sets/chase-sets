import type { ReactNode } from "react";
import { cx } from "../../utils/cx";
import { Card } from "../../components/data-display";

export interface TokenSwatchProps {
  label: ReactNode;
  value: ReactNode;
  color:
    | "brandPrimary"
    | "brandSecondary"
    | "cyan"
    | "indigo"
    | "background"
    | "surface"
    | "surface2"
    | "surface3"
    | "border"
    | "textPrimary"
    | "textSecondary"
    | "success"
    | "warning"
    | "danger";
}

const tokenSwatchClasses: Record<TokenSwatchProps["color"], string> = {
  brandPrimary: "bg-accent",
  brandSecondary: "bg-accent-2",
  cyan: "bg-info",
  indigo: "bg-indigo",
  background: "bg-background",
  surface: "bg-surface",
  surface2: "bg-surface-2",
  surface3: "bg-surface-3",
  border: "bg-border",
  textPrimary: "bg-foreground",
  textSecondary: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function TokenSwatch({ label, value, color }: TokenSwatchProps) {
  return (
    <Card variant="feature">
      <div className="space-y-3">
        <div
          aria-hidden="true"
          className={cx("h-10 rounded-tokenMd border border-muted shadow-tokenSm", tokenSwatchClasses[color])}
        />
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          <div className="font-mono text-xs text-secondary">{value}</div>
        </div>
      </div>
    </Card>
  );
}
