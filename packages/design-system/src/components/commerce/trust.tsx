import type { MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, IconRow, Stack } from "../../primitives/layout";
import { Badge, Progress } from "../feedback";
import { Card } from "../data-display/card";
import { hasReviewCount, normalizeRatingValue, type TrustTone } from "./shared";

export interface TrustBadgeProps {
  children: ReactNode;
  tone?: TrustTone;
  className?: string;
  /** Native title/tooltip text -- e.g. a badge explainer ("what this means"). */
  title?: string;
}

export function TrustBadge({ children, tone = "verified", className, title }: TrustBadgeProps) {
  const iconName: IconName =
    tone === "warning" ? "warning" : tone === "secure" ? "lockClosed" : tone === "policy" ? "help" : "shield";
  const toneClass =
    tone === "warning"
      ? "border-warning-soft bg-warning-soft text-warning"
      : "border-trust-soft bg-trust-soft text-trust";

  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-tokenFull border px-2.5 py-1 text-xs font-semibold leading-4",
        toneClass,
        title ? "cursor-help" : null,
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
    <div className="rounded-tokenMd border border-trust-soft bg-trust-soft p-4">
      <IconRow gap={3} icon={<Icon name="shield" size="md" tone="trust" aria-hidden="true" />}>
        <div className="font-semibold text-foreground">{title}</div>
        <div className="text-sm leading-5 text-secondary">{description}</div>
      </IconRow>
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
        <Stack direction="row" justify="between" align="start" gap={3}>
          <Stack gap={2} minWidth="0">
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
          </Stack>
          {actions}
        </Stack>
      </Card.Header>
      <Card.Body>
        <Grid columns={{ base: 1, sm: 2 }} gap={3}>
          {facts.map((fact) => (
            <div key={fact.label} className="rounded-tokenMd border border-border bg-surface-2 p-3">
              <IconRow gap={2} icon={<Icon name={fact.icon} size="sm" tone="trust" aria-hidden="true" />}>
                <div className="text-xs font-medium text-tertiary">{fact.label}</div>
                <div className="text-sm font-semibold text-foreground">{fact.value}</div>
              </IconRow>
            </div>
          ))}
        </Grid>
        {policies.length ? (
          <div className="mt-4 grid gap-2">
            {policies.map((policy) => (
              <Stack key={policy.label} direction="row" justify="between" align="center" gap={3}>
                <span className="text-sm text-secondary">{policy.label}</span>
                <span className="text-sm font-semibold text-foreground">{policy.value}</span>
              </Stack>
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
        <Stack gap={2}>
          {rows.map((row) => (
            <Grid key={row.stars} templateColumns="3rem 1fr 3rem" align="center" gap={3}>
              <span className="text-sm font-medium">{starLabel ? starLabel(row.stars) : row.stars}</span>
              <Progress value={row.value} />
              <span className="text-right text-sm tabular-nums text-tertiary">{row.value}%</span>
            </Grid>
          ))}
        </Stack>
      </Card.Body>
    </Card>
  );
}

export interface SecurePaymentIndicatorProps {
  label?: ReactNode;
  /**
   * Optional secondary reassurance line (e.g. `Not charged yet` / `No payment
   * until checkout`). Renders quietly beneath the trust label so reassurance
   * lives once, inside this canonical indicator, rather than as an extra banner.
   */
  reassurance?: ReactNode;
}

export function SecurePaymentIndicator({ label, reassurance }: SecurePaymentIndicatorProps) {
  if (reassurance) {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-trust">
          <Icon name="creditCard" size="sm" tone="inherit" aria-hidden="true" />
          {label}
        </span>
        <span className="text-xs leading-4 text-secondary">{reassurance}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-trust">
      <Icon name="creditCard" size="sm" tone="inherit" aria-hidden="true" />
      {label}
    </span>
  );
}
