import type { HTMLAttributes, ReactNode } from "react";
import { Badge, type BadgeProps } from "../../components/feedback";
import { ChaseSetsLogo } from "../../brand/chase-sets-logo";

export interface ConditionBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  condition: "NM" | "LP" | "MP" | "HP" | "DMG";
}

export function ConditionBadge({ condition, ...rest }: ConditionBadgeProps) {
  const tone =
    condition === "NM" ? "success" : condition === "LP" ? "accent" : condition === "MP" ? "warning" : "danger";

  return (
    <Badge {...rest} tone={tone}>
      {condition}
    </Badge>
  );
}

export interface SellerBadgeProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  logo?: ReactNode | false;
  name: ReactNode;
  verified?: boolean;
}

export function SellerBadge({ logo, name, verified = false, ...rest }: SellerBadgeProps) {
  const resolvedLogo = logo === false ? null : (logo ?? <ChaseSetsLogo decorative size={20} />);

  return (
    <div
      {...rest}
      className="inline-flex items-center gap-2 rounded-tokenFull border border-muted bg-elevated px-3 py-1.5 text-sm font-medium text-foreground shadow-tokenSm"
    >
      <span className="inline-flex min-w-0 items-center gap-0">
        {resolvedLogo ? (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{resolvedLogo}</span>
        ) : null}
        <span>{name}</span>
      </span>
      {verified ? <Badge tone="success">Verified</Badge> : null}
    </div>
  );
}

export interface OrderSummaryLine {
  label: ReactNode;
  value: ReactNode;
}

export type MarketplaceStatus = "available" | "marketOnly" | "unavailable" | "verified" | "watching";

const marketplaceStatusLabels: Record<MarketplaceStatus, string> = {
  available: "Available now",
  marketOnly: "Market only",
  unavailable: "Unavailable",
  verified: "Verified",
  watching: "Watching",
};

const marketplaceStatusTones: Record<MarketplaceStatus, BadgeProps["tone"]> = {
  available: "success",
  marketOnly: "neutral",
  unavailable: "neutral",
  verified: "success",
  watching: "warning",
};

export interface MarketStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  status: MarketplaceStatus;
  label?: ReactNode;
}

export function MarketStatusBadge({ status, label, ...rest }: MarketStatusBadgeProps) {
  return (
    <Badge {...rest} tone={marketplaceStatusTones[status]}>
      {label ?? marketplaceStatusLabels[status]}
    </Badge>
  );
}
