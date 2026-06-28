import type { ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, IconRow, Stack, surfaceSemanticToneClasses } from "../../primitives/layout";
import { ToneIcon } from "../../primitives/tone-icon";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";
import { TrustBadge } from "../commerce/trust";
import { quietMoneyClass } from "./shared";
import type { CheckoutPrimitiveTone } from "./shared";

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
  /**
   * The single deferral statement for the surface (e.g. `Final total confirmed
   * at checkout`). Rendered once, beneath the total — never repeated per line.
   */
  totalCaption?: ReactNode;
  /**
   * When the total is not yet a charge-grade quote. Renders the total in the
   * canonical quiet style instead of the bold charge emphasis. `pending` is an
   * accepted alias.
   */
  deferred?: boolean;
  /** Alias for {@link PriceBreakdownProps.deferred}. */
  pending?: boolean;
  reassurance?: ReactNode;
}

export function PriceBreakdown({
  title,
  description,
  lines,
  total,
  totalLabel,
  totalCaption,
  deferred = false,
  pending = false,
  reassurance,
}: PriceBreakdownProps) {
  const isQuiet = deferred || pending;

  return (
    <Card>
      {title || description ? (
        <Card.Header>
          {title ? <Card.Title>{title}</Card.Title> : null}
          {description ? <Card.Description>{description}</Card.Description> : null}
        </Card.Header>
      ) : null}
      <Card.Body>
        <Stack gap={2}>
          {lines.map((line) => (
            <div key={line.label} className="flex items-center justify-between gap-4 text-sm">
              <span className={cx(line.muted ? "text-tertiary" : "text-secondary")}>{line.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{line.value}</span>
            </div>
          ))}
        </Stack>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-x-4 border-t border-border pt-4">
          {totalLabel ? <span className="min-w-0 font-semibold text-foreground">{totalLabel}</span> : null}
          <span
            className={cx(
              "min-w-0 max-w-full break-words text-right leading-tight tabular-nums",
              isQuiet ? cx("text-base", quietMoneyClass) : "text-xl font-bold text-foreground sm:text-2xl",
            )}
          >
            {total}
          </span>
          {totalCaption ? <p className="col-span-2 m-0 mt-1 text-xs leading-5 text-tertiary">{totalCaption}</p> : null}
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
        <Stack gap={4}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-tertiary">Price</div>
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
          <Stack gap={2} data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </Stack>
        </Stack>
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
        <Stack gap={4}>
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
                <div className="text-xs font-semibold uppercase tracking-wide text-tertiary">{label}</div>
                <div className="font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </Stack>
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
            <IconRow
              key={String(item.title)}
              gap={3}
              icon={<Icon name={item.icon ?? "check"} size="md" tone="trust" />}
            >
              <div className="font-semibold text-foreground">{item.title}</div>
              <div className="text-sm leading-5 text-secondary">{item.description}</div>
            </IconRow>
          ))}
        </div>
      </Card.Body>
    </Card>
  );
}

// Marketplace notices reuse the canonical status-tint triple and override only
// the neutral case, which reads with a plain `border`/`text-tertiary` frame
// rather than the muted-border neutral surface tone.
const noticeToneClasses: Record<CheckoutPrimitiveTone, string> = {
  ...surfaceSemanticToneClasses,
  neutral: "border-border bg-surface-2 text-tertiary",
};

export interface MarketplaceNoticeProps {
  tone?: CheckoutPrimitiveTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

const marketplaceNoticeIcons: Record<CheckoutPrimitiveTone, IconName> = {
  neutral: "help",
  info: "help",
  success: "checkCircle",
  warning: "warning",
  danger: "xCircle",
};

export function MarketplaceNotice({ tone = "info", title, description, action }: MarketplaceNoticeProps) {
  return (
    <div className={cx("flex gap-3 rounded-tokenMd border p-4", noticeToneClasses[tone])}>
      <ToneIcon name={marketplaceNoticeIcons[tone]} tone={tone} size="sm" />
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
        <Stack gap={4}>
          <Grid columns={{ base: 1, sm: 2 }} gap={3}>
            <MarketplaceNotice tone="warning" title={chargeStatus} />
            <MarketplaceNotice tone="info" title={nextStep} description={supportPath} />
          </Grid>
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </div>
        </Stack>
      </Card.Body>
    </Card>
  );
}

export interface StickyCtaBarProps {
  /**
   * Optional label above the total (e.g. `Estimated total`). Part of the shared
   * `totalLabel`/`total`/`context` triple unified with `CheckoutStickyActionBar`.
   */
  totalLabel?: ReactNode;
  /** The headline money value. Use this over the deprecated `price` alias. */
  total?: ReactNode;
  /** @deprecated Use {@link StickyCtaBarProps.total}. */
  price?: ReactNode;
  context?: ReactNode;
  /** Canonical reassurance slot — pass a `SecurePaymentIndicator`. */
  reassurance?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  /** Accessible label for the bar region. Defaults to `"Checkout"`. */
  label?: string;
}

export function StickyCtaBar({
  totalLabel,
  total,
  price,
  context,
  reassurance,
  primaryAction,
  secondaryAction,
  label = "Checkout",
}: StickyCtaBarProps) {
  const resolvedTotal = total ?? price;

  return (
    <div
      role="region"
      aria-label={label}
      className="rounded-tokenLg border border-muted bg-background/overlay px-4 py-3 shadow-tokenLg backdrop-blur-xl"
    >
      <div className="mx-auto grid max-w-7xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          {totalLabel ? <div className="text-xs font-medium text-secondary">{totalLabel}</div> : null}
          {resolvedTotal ? <div className="text-lg font-bold tabular-nums text-foreground">{resolvedTotal}</div> : null}
          {context ? <div className="text-xs leading-5 text-tertiary sm:truncate">{context}</div> : null}
          {reassurance ? <div className="mt-1">{reassurance}</div> : null}
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:shrink-0" data-primary-action-count="1">
          {secondaryAction}
          {primaryAction}
        </div>
      </div>
    </div>
  );
}
