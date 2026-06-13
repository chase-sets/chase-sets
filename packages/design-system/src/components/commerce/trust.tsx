import type { MouseEventHandler, ReactNode } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Clock,
  CreditCard,
  HelpCircle,
  Lock,
  MapPin,
  PackageCheck,
  ShieldCheck,
  Star,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../compat/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../compat/card";
import { Progress } from "../compat/progress";
import { hasReviewCount, normalizeRatingValue, type TrustTone } from "./shared";

export interface TrustBadgeProps {
  children: ReactNode;
  tone?: TrustTone;
  className?: string;
}

export function TrustBadge({ children, tone = "verified", className }: TrustBadgeProps) {
  const Icon =
    tone === "warning" ? AlertTriangle : tone === "secure" ? Lock : tone === "policy" ? HelpCircle : ShieldCheck;
  const toneClass =
    tone === "warning"
      ? "border-warning-soft bg-warning-soft text-warning"
      : "border-trust-soft bg-trust-soft text-trust";

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-tokenFull border px-2.5 py-1 text-xs font-semibold leading-4",
        toneClass,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
    <div className="flex gap-3 rounded-[var(--radius)] border border-trust-soft bg-trust-soft p-4">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-trust" aria-hidden="true" />
      <div>
        <div className="font-semibold text-[var(--foreground)]">{title}</div>
        <div className="text-sm leading-5 text-[var(--text-secondary)]">{description}</div>
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
      className={cn("inline-flex items-center gap-1.5 text-[var(--text-secondary)]", compact ? "text-xs" : "text-sm")}
      aria-label={label ?? `${value} rating${count ? ` from ${count} reviews` : ""}`}
    >
      <Star className="h-4 w-4 fill-rating text-rating" aria-hidden="true" />
      <span className="font-semibold tabular-nums text-[var(--foreground)]">{value.toFixed(1)}</span>
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
      className="ds-focus inline-block min-w-0 max-w-full truncate font-semibold leading-5 text-[var(--foreground)] underline-offset-2 transition hover:text-[var(--primary)] hover:underline"
    >
      {accountName}
    </a>
  ) : (
    <span className="min-w-0 truncate font-semibold leading-5 text-[var(--foreground)]">{accountName}</span>
  );
  const reputationNode = hasReputation ? (
    <RatingSummary value={rating} count={reviewCount} label={ratingLabel} compact />
  ) : (
    <span
      className="text-xs font-medium leading-4 text-[var(--muted-foreground)]"
      aria-label={emptyAccessibleLabel}
      title={emptyAccessibleLabel}
    >
      {emptyLabel}
    </span>
  );

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full flex-col items-start gap-0.5 text-left",
        align === "end" && "items-end text-right",
        variant === "framed"
          ? "rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 shadow-[var(--shadow-sm)]"
          : null,
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
    completedSales ? { icon: PackageCheck, label: "Completed", value: completedSales } : null,
    responseTime ? { icon: Clock, label: "Response", value: responseTime } : null,
    shipsFrom ? { icon: MapPin, label: "Ships from", value: shipsFrom } : null,
    joined ? { icon: BadgeCheck, label: "Account since", value: joined } : null,
  ].filter(Boolean) as Array<{ icon: typeof PackageCheck; label: string; value: ReactNode }>;
  const reputationRating = normalizeRatingValue(rating);
  const hasReputation = reputationRating !== null && hasReviewCount(reviewCount);

  return (
    <Card className="p-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <CardTitle>{name}</CardTitle>
              {verified ? <TrustBadge>Verified account</TrustBadge> : <Badge variant="outline">New account</Badge>}
            </div>
            {hasReputation ? (
              <RatingSummary value={reputationRating} count={reviewCount} compact />
            ) : (
              <span
                className="text-xs font-medium leading-4 text-[var(--muted-foreground)]"
                aria-label="No feedback yet"
                title="No feedback yet"
              >
                New
              </span>
            )}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="flex gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <fact.icon className="mt-0.5 h-4 w-4 text-trust" aria-hidden="true" />
              <div>
                <div className="text-xs font-medium text-[var(--muted-foreground)]">{fact.label}</div>
                <div className="text-sm font-semibold text-[var(--foreground)]">{fact.value}</div>
              </div>
            </div>
          ))}
        </div>
        {policies.length ? (
          <div className="mt-4 grid gap-2">
            {policies.map((policy) => (
              <div key={policy.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-[var(--text-secondary)]">{policy.label}</span>
                <span className="font-semibold text-[var(--foreground)]">{policy.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
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
      <CardHeader>
        {title ? <CardTitle>{title}</CardTitle> : null}
        <CardDescription>
          <RatingSummary value={average} count={count} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.stars} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="font-medium">{starLabel ? starLabel(row.stars) : row.stars}</span>
              <Progress value={row.value} className="h-2" />
              <span className="text-right tabular-nums text-[var(--muted-foreground)]">{row.value}%</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function SecurePaymentIndicator({ label }: { label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-trust">
      <CreditCard className="h-4 w-4" aria-hidden="true" />
      {label}
    </span>
  );
}
