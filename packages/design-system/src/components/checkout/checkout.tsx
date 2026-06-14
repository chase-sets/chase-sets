import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";
import { TrustBadge } from "../commerce/trust";

export type CheckoutPrimitiveTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface CheckoutSummaryLine {
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
}

export interface CheckoutSummaryItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  facts?: ReactNode[];
  price?: ReactNode;
  quantity?: ReactNode;
  image?: {
    src: string;
    alt: string;
  };
  thumbnail?: ReactNode;
}

const toneClasses: Record<CheckoutPrimitiveTone, string> = {
  neutral: "border-muted bg-surface-2 text-secondary",
  info: "border-info-soft bg-info-soft text-info",
  success: "border-success-soft bg-success-soft text-success",
  warning: "border-warning-soft bg-warning-soft text-warning",
  danger: "border-danger-soft bg-danger-soft text-danger",
};

function CheckoutStatusBadge({ tone = "neutral", children }: { tone?: CheckoutPrimitiveTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-tokenMd border px-2.5 py-1 text-xs font-semibold",
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

export interface CheckoutSummaryLineItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  item: CheckoutSummaryItem;
}

export function CheckoutSummaryLineItem({ item, ...rest }: CheckoutSummaryLineItemProps) {
  return (
    <div {...rest} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-3 py-3">
      <div className="relative h-14 w-14 overflow-hidden rounded-tokenMd border border-muted bg-surface-2">
        {item.thumbnail ??
          (item.image ? (
            <img src={item.image.src} alt={item.image.alt} className="h-full w-full object-cover" loading="eager" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-secondary" aria-hidden="true">
              <Icon name="image" size="md" tone="secondary" />
            </span>
          ))}
        {item.quantity ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-tokenFull bg-foreground px-1.5 py-0.5 text-center text-xs font-bold leading-none text-background">
            {item.quantity}
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-5 text-foreground">{item.title}</div>
        {item.subtitle ? <div className="mt-0.5 text-xs leading-5 text-secondary">{item.subtitle}</div> : null}
        {item.facts?.length ? (
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs leading-5 text-secondary">
            {item.facts.map((fact, index) => (
              <span key={index} className="min-w-0">
                {fact}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {item.price ? (
        <div className="text-right text-sm font-semibold tabular-nums text-foreground">{item.price}</div>
      ) : null}
    </div>
  );
}

export interface CheckoutTotalsProps extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  lines: CheckoutSummaryLine[];
  totalLabel: ReactNode;
  total: ReactNode;
  currency?: ReactNode;
}

export function CheckoutTotals({ lines, totalLabel, total, currency, ...rest }: CheckoutTotalsProps) {
  return (
    <dl {...rest} className="grid gap-2">
      {lines.map((line, index) => (
        <div key={index} className="flex items-start justify-between gap-4 text-sm leading-5">
          <dt className={cx(line.muted ? "text-secondary" : "text-foreground")}>{line.label}</dt>
          <dd className="text-right font-medium tabular-nums text-foreground">{line.value}</dd>
        </div>
      ))}
      <div className="mt-2 flex items-end justify-between gap-4 border-t border-muted pt-3">
        <dt className="text-base font-semibold text-foreground">{totalLabel}</dt>
        <dd className="text-right text-xl font-bold leading-tight tabular-nums text-foreground">
          {currency ? <span className="mr-1 align-baseline text-xs font-medium text-secondary">{currency}</span> : null}
          {total}
        </dd>
      </div>
    </dl>
  );
}

export interface CheckoutSummaryPanelProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  statusTone?: CheckoutPrimitiveTone;
  items?: CheckoutSummaryItem[];
  totals: CheckoutSummaryLine[];
  totalLabel: ReactNode;
  total: ReactNode;
  currency?: ReactNode;
  actions?: ReactNode;
  reassurance?: ReactNode;
}

export function CheckoutSummaryPanel({
  title,
  subtitle,
  status,
  statusTone = "neutral",
  items = [],
  totals,
  totalLabel,
  total,
  currency,
  actions,
  reassurance,
  ...rest
}: CheckoutSummaryPanelProps) {
  return (
    <section {...rest} className="rounded-tokenLg border border-muted bg-surface p-4 shadow-tokenSm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold text-foreground">{title}</h2>
          {subtitle ? <p className="m-0 mt-1 text-sm leading-5 text-secondary">{subtitle}</p> : null}
        </div>
        {status ? <CheckoutStatusBadge tone={statusTone}>{status}</CheckoutStatusBadge> : null}
      </div>
      {items.length ? (
        <div className="mt-3 divide-y divide-muted">
          {items.map((item) => (
            <CheckoutSummaryLineItem key={item.id} item={item} />
          ))}
        </div>
      ) : null}
      <div className="mt-4">
        <CheckoutTotals lines={totals} totalLabel={totalLabel} total={total} currency={currency} />
      </div>
      {reassurance ? (
        <div className="mt-4 rounded-tokenMd border border-success-soft bg-success-soft p-3 text-sm font-medium leading-5 text-success">
          {reassurance}
        </div>
      ) : null}
      {actions ? (
        <div className="mt-4 grid gap-2" data-primary-action-count="1">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

export interface CheckoutMobileSummaryDisclosureProps extends Omit<
  HTMLAttributes<HTMLDetailsElement>,
  "className" | "style"
> {
  label: ReactNode;
  collapsedSummary: ReactNode;
  total: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function CheckoutMobileSummaryDisclosure({
  label,
  collapsedSummary,
  total,
  children,
  defaultOpen = false,
  ...rest
}: CheckoutMobileSummaryDisclosureProps) {
  return (
    <details
      {...rest}
      className="rounded-tokenLg border border-muted bg-surface shadow-tokenSm lg:hidden"
      open={defaultOpen}
    >
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-tokenLg px-4 py-3 text-left marker:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-accent">{label}</span>
          <span className="block text-xs leading-5 text-secondary">{collapsedSummary}</span>
        </span>
        <span className="shrink-0 text-right text-lg font-bold tabular-nums text-foreground">{total}</span>
      </summary>
      <div className="border-t border-muted p-4">{children}</div>
    </details>
  );
}

export interface CheckoutFlowShellProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  main: ReactNode;
  desktopSummary: ReactNode;
  mobileSummary?: ReactNode;
  stickyAction?: ReactNode;
  summaryLabel?: string;
}

export function CheckoutFlowShell({
  main,
  desktopSummary,
  mobileSummary,
  stickyAction,
  summaryLabel = "Checkout summary",
  ...rest
}: CheckoutFlowShellProps) {
  return (
    <div {...rest} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-6">
      <div className="min-w-0 space-y-5">
        {mobileSummary}
        {stickyAction}
        {main}
      </div>
      <aside aria-label={summaryLabel} className="hidden min-w-0 lg:block">
        <div className="sticky top-20">{desktopSummary}</div>
      </aside>
    </div>
  );
}

export interface CheckoutSavedInfoRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  supportingText?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  status?: ReactNode;
  statusTone?: CheckoutPrimitiveTone;
}

export function CheckoutSavedInfoRow({
  label,
  value,
  supportingText,
  icon,
  action,
  status,
  statusTone = "neutral",
  ...rest
}: CheckoutSavedInfoRowProps) {
  return (
    <div
      {...rest}
      className="grid gap-3 border-b border-muted px-4 py-3 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm text-secondary">
        {icon ? <Icon name={icon} size="sm" tone="secondary" /> : null}
        <span>{label}</span>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-5 text-foreground">{value}</div>
        {supportingText ? <div className="text-xs leading-5 text-secondary">{supportingText}</div> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {status ? <CheckoutStatusBadge tone={statusTone}>{status}</CheckoutStatusBadge> : null}
        {action}
      </div>
    </div>
  );
}

export interface CheckoutSavedInfoGroupProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "className" | "style" | "title"
> {
  title?: ReactNode;
  children: ReactNode;
}

export function CheckoutSavedInfoGroup({ title, children, ...rest }: CheckoutSavedInfoGroupProps) {
  return (
    <section {...rest} className="overflow-hidden rounded-tokenLg border border-muted bg-surface shadow-tokenSm">
      {title ? (
        <h2 className="m-0 border-b border-muted px-4 py-3 text-base font-semibold text-foreground">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

export interface CheckoutFormSectionProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}

export function CheckoutFormSection({ title, description, badge, children, ...rest }: CheckoutFormSectionProps) {
  return (
    <section {...rest} className="grid gap-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="m-0 text-xl font-semibold leading-7 text-foreground">{title}</h2>
          {description ? <p className="m-0 mt-1 text-sm leading-5 text-secondary">{description}</p> : null}
        </div>
        {badge}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export interface CheckoutExpressActionsProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  actions: ReactNode;
  dividerLabel?: ReactNode;
}

export function CheckoutExpressActions({ label, actions, dividerLabel = "OR", ...rest }: CheckoutExpressActionsProps) {
  return (
    <div {...rest} className="grid gap-3 text-center">
      <div className="text-sm text-secondary">{label}</div>
      <div className="grid gap-2 sm:grid-cols-2">{actions}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-xs text-secondary">
        <span className="h-px bg-muted" aria-hidden="true" />
        <span>{dividerLabel}</span>
        <span className="h-px bg-muted" aria-hidden="true" />
      </div>
    </div>
  );
}

export interface CheckoutStateNoticeProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  tone?: CheckoutPrimitiveTone;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}

const defaultNoticeIcons: Record<CheckoutPrimitiveTone, IconName> = {
  neutral: "info",
  info: "info",
  success: "check",
  warning: "warning",
  danger: "warning",
};

export function CheckoutStateNotice({
  tone = "info",
  title,
  description,
  icon = defaultNoticeIcons[tone],
  action,
  ...rest
}: CheckoutStateNoticeProps) {
  return (
    <div {...rest} className={cx("flex gap-3 rounded-tokenLg border p-4", toneClasses[tone])}>
      <Icon
        name={icon}
        size="sm"
        tone={tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "success" ? "success" : "accent"}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? <div className="mt-1 text-sm leading-5 text-secondary">{description}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export interface CheckoutReadinessPromptProps extends CheckoutStateNoticeProps {
  facts?: CheckoutSummaryLine[];
  secondaryAction?: ReactNode;
}

export function CheckoutReadinessPrompt({
  facts = [],
  action,
  secondaryAction,
  children,
  ...rest
}: CheckoutReadinessPromptProps) {
  return (
    <CheckoutStateNotice
      {...rest}
      action={
        action || secondaryAction || facts.length || children ? (
          <div className="grid gap-3">
            {facts.length ? (
              <dl className="grid gap-2 text-sm">
                {facts.map((fact, index) => (
                  <div key={index} className="flex items-start justify-between gap-4">
                    <dt className="text-secondary">{fact.label}</dt>
                    <dd className="text-right font-semibold tabular-nums text-foreground">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {children}
            {action || secondaryAction ? (
              <div className="flex flex-wrap gap-2" data-primary-action-count={action ? "1" : undefined}>
                {action}
                {secondaryAction}
              </div>
            ) : null}
          </div>
        ) : null
      }
    />
  );
}

export interface CheckoutConfirmationPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  referenceLabel?: ReactNode;
  referenceValue?: ReactNode;
  supportReferenceLabel?: ReactNode;
  supportReferenceValue?: ReactNode;
  totalLabel?: ReactNode;
  total?: ReactNode;
  nextSteps?: Array<{ title: ReactNode; description: ReactNode; icon?: IconName }>;
  actions?: ReactNode;
  tone?: CheckoutPrimitiveTone;
}

export function CheckoutConfirmationPanel({
  title,
  description,
  referenceLabel,
  referenceValue,
  supportReferenceLabel,
  supportReferenceValue,
  totalLabel,
  total,
  nextSteps = [],
  actions,
  tone = "success",
  ...rest
}: CheckoutConfirmationPanelProps) {
  return (
    <section {...rest} className={cx("rounded-tokenLg border bg-surface p-5 shadow-tokenSm", toneClasses[tone])}>
      <div className="grid gap-3">
        <CheckoutStatusBadge tone={tone}>{title}</CheckoutStatusBadge>
        {description ? <p className="m-0 text-sm leading-5 text-secondary">{description}</p> : null}
        {referenceLabel || supportReferenceLabel || totalLabel ? (
          <dl className="grid gap-2 rounded-tokenMd border border-muted bg-background p-3 text-sm">
            {referenceLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{referenceLabel}</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{referenceValue}</dd>
              </div>
            ) : null}
            {supportReferenceLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{supportReferenceLabel}</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">
                  {supportReferenceValue}
                </dd>
              </div>
            ) : null}
            {totalLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{totalLabel}</dt>
                <dd className="min-w-0 break-words text-right font-bold tabular-nums text-foreground">{total}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {nextSteps.length ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {nextSteps.map((step, index) => (
              <div key={index} className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {step.icon ? <Icon name={step.icon} size="sm" tone="accent" /> : null}
                  {step.title}
                </div>
                <div className="mt-1 text-sm leading-5 text-secondary">{step.description}</div>
              </div>
            ))}
          </div>
        ) : null}
        {actions ? (
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export interface CheckoutStickyActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  totalLabel: ReactNode;
  total: ReactNode;
  context?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  mobileOffset?: "navigation" | "none";
}

export function CheckoutStickyActionBar({
  totalLabel,
  total,
  context,
  primaryAction,
  secondaryAction,
  mobileOffset = "navigation",
  ...rest
}: CheckoutStickyActionBarProps) {
  return (
    <div
      {...rest}
      className={cx(
        "sticky z-sticky rounded-tokenLg border border-muted bg-background/overlay px-3 py-2 shadow-tokenLg backdrop-blur-xl md:hidden",
        mobileOffset === "navigation" ? "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]" : "bottom-0",
      )}
    >
      <div className="grid gap-3">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">{totalLabel}</div>
            {context ? <div className="text-xs leading-5 text-secondary">{context}</div> : null}
          </div>
          <div className="text-right text-xl font-bold tabular-nums text-foreground">{total}</div>
        </div>
        <div
          className={cx("grid gap-2", secondaryAction ? "grid-cols-2" : "grid-cols-1")}
          data-primary-action-count="1"
        >
          {secondaryAction}
          {primaryAction}
        </div>
      </div>
    </div>
  );
}

// Marketplace-specific checkout surfaces. Folded in from the former
// `components/commerce/checkout.tsx` module so the design system has a single
// canonical home for checkout behavior. Rebuilt on canonical primitives
// (cx, semantic tokens, DS Icon, DS Badge/Card) and the canonical tone
// vocabulary (`danger`, never `error`).

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

const noticeToneClasses: Record<CheckoutPrimitiveTone, string> = {
  success: "border-success-soft bg-success-soft text-success",
  warning: "border-warning-soft bg-warning-soft text-warning",
  danger: "border-danger-soft bg-danger-soft text-danger",
  info: "border-info-soft bg-info-soft text-info",
  neutral: "border-border bg-surface-2 text-tertiary",
};

export interface MarketplaceNoticeProps {
  tone?: CheckoutPrimitiveTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function MarketplaceNotice({ tone = "info", title, description, action }: MarketplaceNoticeProps) {
  const iconName: IconName =
    tone === "danger" ? "xCircle" : tone === "warning" ? "warning" : tone === "success" ? "checkCircle" : "help";

  return (
    <div className={cx("flex gap-3 rounded-tokenMd border p-4", noticeToneClasses[tone])}>
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
