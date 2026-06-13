import type { ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";
import { TrustBadge } from "./trust";
import { statusClasses, type StatusTone } from "./shared";

export interface PriceBreakdownProps {
  title?: ReactNode;
  description?: ReactNode;
  lines: Array<{ label: string; value: ReactNode; muted?: boolean }>;
  total: ReactNode;
  totalLabel?: ReactNode;
  reassurance?: ReactNode;
}

export function PriceBreakdown({ title, description, lines, total, totalLabel, reassurance }: PriceBreakdownProps) {
  return (
    <Card>
      {title || description ? (
        <Card.Header>
          {title ? <Card.Title>{title}</Card.Title> : null}
          {description ? <Card.Description>{description}</Card.Description> : null}
        </Card.Header>
      ) : null}
      <Card.Body>
        <div className="grid gap-2">
          {lines.map((line) => (
            <div key={line.label} className="flex items-center justify-between gap-4 text-sm">
              <span className={cx(line.muted ? "text-tertiary" : "text-secondary")}>{line.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{line.value}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 border-t border-border pt-4">
          {totalLabel ? <span className="min-w-0 font-semibold text-foreground">{totalLabel}</span> : null}
          <span className="min-w-0 max-w-full break-words text-right text-xl font-bold leading-tight tabular-nums text-foreground sm:text-2xl">
            {total}
          </span>
        </div>
        {reassurance ? (
          <div className="mt-4 rounded-tokenMd bg-trust-soft p-3 text-sm font-medium text-trust">{reassurance}</div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

export interface ListingPurchasePanelProps {
  title: ReactNode;
  price: ReactNode;
  seller: ReactNode;
  trust: ReactNode;
  accountTrust?: ReactNode;
  availability: ReactNode;
  fulfillment: ReactNode;
  policy: ReactNode;
  protection: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  reassurance?: ReactNode;
}

export function ListingPurchasePanel({
  title,
  price,
  seller,
  trust,
  accountTrust,
  availability,
  fulfillment,
  policy,
  protection,
  primaryAction,
  secondaryAction,
  reassurance,
}: ListingPurchasePanelProps) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {reassurance ? <Card.Description>{reassurance}</Card.Description> : null}
      </Card.Header>
      <Card.Body>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-tertiary">Price</div>
              <div className="text-3xl font-bold tabular-nums text-foreground">{price}</div>
            </div>
            {accountTrust ? null : <TrustBadge>{trust}</TrustBadge>}
          </div>
          <div className="grid gap-2 rounded-tokenMd border border-border bg-surface-2 p-3 text-sm">
            {[
              ["Seller", accountTrust ?? seller],
              ["Availability", availability],
              ["Fulfillment", fulfillment],
              ["Returns", policy],
              ["Protection", protection],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between gap-4">
                <span className="text-secondary">{label}</span>
                <div className="text-right font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-2" data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}

export interface OrderIntentSummaryProps {
  title: ReactNode;
  subtitle?: ReactNode;
  price: ReactNode;
  quantity: ReactNode;
  seller: ReactNode;
  availability: ReactNode;
  fulfillment: ReactNode;
  protection: ReactNode;
  paymentStatus: ReactNode;
}

export function OrderIntentSummary({
  title,
  subtitle,
  price,
  quantity,
  seller,
  availability,
  fulfillment,
  protection,
  paymentStatus,
}: OrderIntentSummaryProps) {
  return (
    <Card>
      <Card.Body>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-base font-semibold leading-6 text-foreground">{title}</div>
              {subtitle ? <div className="text-sm text-secondary">{subtitle}</div> : null}
            </div>
            <div className="text-right text-xl font-bold tabular-nums text-foreground">{price}</div>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["Seller", seller],
              ["Quantity", quantity],
              ["Availability", availability],
              ["Fulfillment", fulfillment],
              ["Protection", protection],
              ["Payment", paymentStatus],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-tokenMd bg-surface-2 p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-tertiary">{label}</div>
                <div className="font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}

export interface OrderProtectionModuleProps {
  title?: ReactNode;
  items: Array<{ title: ReactNode; description: ReactNode; icon?: IconName }>;
}

export function OrderProtectionModule({ title, items }: OrderProtectionModuleProps) {
  return (
    <Card>
      {title ? (
        <Card.Header>
          <Card.Title>
            <span className="flex items-center gap-2 text-trust">
              <Icon name="shield" size="md" tone="trust" aria-hidden="true" />
              {title}
            </span>
          </Card.Title>
        </Card.Header>
      ) : null}
      <Card.Body>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-5 rounded-tokenMd border border-trust-soft bg-trust-soft p-4">
          {items.map((item) => (
            <div key={String(item.title)} className="flex min-w-0 gap-3">
              <div className="mt-0.5 shrink-0 text-trust">
                <Icon name={item.icon ?? "check"} size="md" tone="inherit" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-foreground">{item.title}</div>
                <div className="text-sm leading-5 text-secondary">{item.description}</div>
              </div>
            </div>
          ))}
        </div>
      </Card.Body>
    </Card>
  );
}

export interface MarketplaceNoticeProps {
  tone?: StatusTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function MarketplaceNotice({ tone = "info", title, description, action }: MarketplaceNoticeProps) {
  const iconName: IconName =
    tone === "error" ? "xCircle" : tone === "warning" ? "warning" : tone === "success" ? "checkCircle" : "help";

  return (
    <div className={cx("flex gap-3 rounded-tokenMd border p-4", statusClasses[tone])}>
      <span className="mt-0.5 shrink-0">
        <Icon name={iconName} size="md" tone="inherit" aria-hidden="true" />
      </span>
      <div className="grid gap-2">
        <div className="font-semibold text-foreground">{title}</div>
        {description ? <div className="text-sm leading-5 text-secondary">{description}</div> : null}
        {action ? <div>{action}</div> : null}
      </div>
    </div>
  );
}

export interface PaymentRecoveryPanelProps {
  statusLabel: ReactNode;
  title: ReactNode;
  description: ReactNode;
  chargeStatus: ReactNode;
  nextStep: ReactNode;
  supportPath?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
}

export function PaymentRecoveryPanel({
  statusLabel,
  title,
  description,
  chargeStatus,
  nextStep,
  supportPath,
  primaryAction,
  secondaryAction,
}: PaymentRecoveryPanelProps) {
  return (
    <Card>
      <Card.Header>
        <div>
          <Badge tone="warning" variant="soft">
            {statusLabel}
          </Badge>
        </div>
        <Card.Title>{title}</Card.Title>
        <Card.Description>{description}</Card.Description>
      </Card.Header>
      <Card.Body>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <MarketplaceNotice tone="warning" title={chargeStatus} />
            <MarketplaceNotice tone="info" title={nextStep} description={supportPath} />
          </div>
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}

export interface StickyCtaBarProps {
  price?: ReactNode;
  context?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
}

export function StickyCtaBar({ price, context, primaryAction, secondaryAction }: StickyCtaBarProps) {
  return (
    <div className="rounded-tokenLg border border-border bg-[color-mix(in_srgb,var(--card)_94%,transparent)] px-4 py-3 shadow-overlay backdrop-blur">
      <div className="mx-auto grid max-w-7xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          {price ? <div className="text-lg font-bold tabular-nums text-foreground">{price}</div> : null}
          {context ? <div className="text-xs leading-5 text-tertiary sm:truncate">{context}</div> : null}
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:shrink-0" data-primary-action-count="1">
          {secondaryAction}
          {primaryAction}
        </div>
      </div>
    </div>
  );
}
