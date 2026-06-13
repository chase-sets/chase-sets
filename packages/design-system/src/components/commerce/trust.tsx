import type { MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";
import { Progress } from "../compat/progress";
import { hasReviewCount, normalizeRatingValue, type TrustTone } from "./shared";

export interface TrustBadgeProps {
  children: ReactNode;
  tone?: TrustTone;
  className?: string;
}

export function TrustBadge({ children, tone = "verified", className }: TrustBadgeProps) {
  const iconName: IconName =
    tone === "warning" ? "warning" : tone === "secure" ? "lockClosed" : tone === "policy" ? "help" : "shield";
  const toneClass =
    tone === "warning"
      ? "border-warning-soft bg-warning-soft text-warning"
      : "border-trust-soft bg-trust-soft text-trust";

  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-tokenFull border px-2.5 py-1 text-xs font-semibold leading-4",
        toneClass,
        className,
      )}
    >
      <Icon name={iconName} size="sm" tone="inherit" aria-hidden="true" />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

export interface NamedTrustBadgeProps {
  label: ReactNode;
  className?: string;
}

export function VerifiedAccountBadge({ label, className }: NamedTrustBadgeProps) {
  return <TrustBadge className={className}>{label}</TrustBadge>;
}

export function OrderProtectionBadge({ label, className }: NamedTrustBadgeProps) {
  return (
    <TrustBadge tone="protection" className={className}>
      {label}
    </TrustBadge>
  );
}

export function SecurePaymentCue({ label, className }: NamedTrustBadgeProps) {
  return (
    <TrustBadge tone="secure" className={className}>
      {label}
    </TrustBadge>
  );
}

export interface PlatformCredibilityCueProps {
  title: ReactNode;
  description: ReactNode;
}

export function PlatformCredibilityCue({ title, description }: PlatformCredibilityCueProps) {
  return (
    <div className="flex gap-3 rounded-tokenMd border border-trust-soft bg-trust-soft p-4">
      <span className="mt-0.5 shrink-0">
        <Icon name="shield" size="md" tone="trust" aria-hidden="true" />
      </span>
      <div>
        <div className="font-semibold text-foreground">{title}</div>
        <div className="text-sm leading-5 text-secondary">{description}</div>
      </div>
    </div>
  );
}

export interface RatingSummaryProps {
  value: number;
  count?: number | string;
  label?: string;
  compact?: boolean;
}

export function RatingSummary({ value, count, label, compact = false }: RatingSummaryProps) {
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 text-secondary", compact ? "text-xs" : "text-sm")}
      aria-label={label ?? `${value} rating${count ? ` from ${count} reviews` : ""}`}
    >
      <Icon name="star" size="sm" tone="rating" aria-hidden="true" />
      <span className="font-semibold tabular-nums text-foreground">{value.toFixed(1)}</span>
      {count ? <span className="tabular-nums">({count})</span> : null}
    </span>
  );
}

export interface AccountReputationSummaryProps {
  accountName: ReactNode;
  href?: string | null;
  averageRating?: number | string | null;
  reviewCount?: number | string | null;
  emptyLabel?: ReactNode;
  emptyAccessibleLabel?: string;
  variant?: "inline" | "framed";
  align?: "start" | "end";
  ratingLabel?: string;
  onLinkClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
}

export function AccountReputationSummary({
  accountName,
  href,
  averageRating,
  reviewCount,
  emptyLabel = "New",
  emptyAccessibleLabel = "No feedback yet",
  variant = "inline",
  align = "start",
  ratingLabel,
  onLinkClick,
  className,
}: AccountReputationSummaryProps) {
  const rating = normalizeRatingValue(averageRating);
  const hasReputation = rating !== null && hasReviewCount(reviewCount);
  const accountNameNode = href ? (
    <a
      href={href}
      onClick={onLinkClick}
      className="ds-focus inline-block min-w-0 max-w-full truncate font-semibold leading-5 text-foreground underline-offset-2 transition hover:text-accent hover:underline"
    >
      {accountName}
    </a>
  ) : (
    <span className="min-w-0 truncate font-semibold leading-5 text-foreground">{accountName}</span>
  );
  const reputationNode = hasReputation ? (
    <RatingSummary value={rating} count={reviewCount} label={ratingLabel} compact />
  ) : (
    <span
      className="text-xs font-medium leading-4 text-tertiary"
      aria-label={emptyAccessibleLabel}
      title={emptyAccessibleLabel}
    >
      {emptyLabel}
    </span>
  );

  return (
    <span
      className={cx(
        "inline-flex min-w-0 max-w-full flex-col items-start gap-0.5 text-left",
        align === "end" && "items-end text-right",
        variant === "framed" ? "rounded-tokenSm border border-border bg-surface-2 px-2.5 py-2 shadow-tokenSm" : null,
        className,
      )}
    >
      {accountNameNode}
      {reputationNode}
    </span>
  );
}

export interface AccountTrustCardProps {
  name: string;
  verified?: boolean;
  rating?: number;
  reviewCount?: number | string;
  completedSales?: ReactNode;
  responseTime?: ReactNode;
  shipsFrom?: ReactNode;
  joined?: ReactNode;
  policies?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}

export function AccountTrustCard({
  name,
  verified = false,
  rating,
  reviewCount,
  completedSales,
  responseTime,
  shipsFrom,
  joined,
  policies = [],
  actions,
}: AccountTrustCardProps) {
  const facts = [
    completedSales ? { icon: "packageCheck" as const, label: "Completed", value: completedSales } : null,
    responseTime ? { icon: "clock" as const, label: "Response", value: responseTime } : null,
    shipsFrom ? { icon: "mapPin" as const, label: "Ships from", value: shipsFrom } : null,
    joined ? { icon: "badgeCheck" as const, label: "Account since", value: joined } : null,
  ].filter(Boolean) as Array<{ icon: IconName; label: string; value: ReactNode }>;
  const reputationRating = normalizeRatingValue(rating);
  const hasReputation = reputationRating !== null && hasReviewCount(reviewCount);

  return (
    <Card>
      <Card.Header>
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Card.Title>{name}</Card.Title>
              {verified ? (
                <TrustBadge>Verified account</TrustBadge>
              ) : (
                <Badge variant="outline" tone="neutral">
                  New account
                </Badge>
              )}
            </div>
            {hasReputation ? (
              <RatingSummary value={reputationRating} count={reviewCount} compact />
            ) : (
              <span
                className="text-xs font-medium leading-4 text-tertiary"
                aria-label="No feedback yet"
                title="No feedback yet"
              >
                New
              </span>
            )}
          </div>
          {actions}
        </div>
      </Card.Header>
      <Card.Body>
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex gap-2 rounded-tokenMd border border-border bg-surface-2 p-3">
              <span className="mt-0.5">
                <Icon name={fact.icon} size="sm" tone="trust" aria-hidden="true" />
              </span>
              <div>
                <div className="text-xs font-medium text-tertiary">{fact.label}</div>
                <div className="text-sm font-semibold text-foreground">{fact.value}</div>
              </div>
            </div>
          ))}
        </div>
        {policies.length ? (
          <div className="mt-4 grid gap-2">
            {policies.map((policy) => (
              <div key={policy.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-secondary">{policy.label}</span>
                <span className="font-semibold text-foreground">{policy.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

export interface RatingDistributionProps {
  title?: ReactNode;
  average: number;
  count: number | string;
  rows: Array<{ stars: number; value: number }>;
  starLabel?: (stars: number) => ReactNode;
}

export function RatingDistribution({ title, average, count, rows, starLabel }: RatingDistributionProps) {
  return (
    <Card>
      <Card.Header>
        {title ? <Card.Title>{title}</Card.Title> : null}
        <Card.Description>
          <RatingSummary value={average} count={count} />
        </Card.Description>
      </Card.Header>
      <Card.Body>
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.stars} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="font-medium">{starLabel ? starLabel(row.stars) : row.stars}</span>
              <Progress value={row.value} className="h-2" />
              <span className="text-right tabular-nums text-tertiary">{row.value}%</span>
            </div>
          ))}
        </div>
      </Card.Body>
    </Card>
  );
}

export function SecurePaymentIndicator({ label }: { label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-trust">
      <Icon name="creditCard" size="sm" tone="inherit" aria-hidden="true" />
      {label}
    </span>
  );
}
