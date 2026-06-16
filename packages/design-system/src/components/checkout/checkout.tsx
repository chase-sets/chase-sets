import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, IconRow, Stack, Surface, surfaceSemanticToneClasses } from "../../primitives/layout";
import { ToneIcon } from "../../primitives/tone-icon";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";
import { Image } from "../data-display/image";
import { TrustBadge } from "../commerce/trust";

export type CheckoutPrimitiveTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface CheckoutSummaryLine {
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
}

/**
 * Pricing state for a summary line. `exact` is a locked, charge-grade price;
 * `indicative` is a known floor surfaced as `from $X`; `deferred` defers the
 * line entirely as a single quiet `Priced at checkout` statement.
 */
export type CheckoutLinePriceState = "exact" | "indicative" | "deferred";

export interface CheckoutSummaryItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  facts?: ReactNode[];
  price?: ReactNode;
  /**
   * How the line price reads. Defaults to `exact`. `indicative` prefixes the
   * price with `from`; `deferred` ignores `price` and shows the quiet
   * `deferredPriceLabel` instead so a missing quote never repeats a deferral
   * string in the price slot.
   */
  priceState?: CheckoutLinePriceState;
  /** Prefix for an `indicative` price. Defaults to `from`. */
  indicativePrefix?: ReactNode;
  /** Quiet text shown when `priceState` is `deferred`. Defaults to `Priced at checkout`. */
  deferredPriceLabel?: ReactNode;
  quantity?: ReactNode;
  image?: {
    src: string;
    alt: string;
  };
  thumbnail?: ReactNode;
}

// One canonical quiet style for a deferred/pending money value, shared by every
// totals and line primitive so the "repeat the deferral string in five slots"
// anti-pattern is impossible to express: there is exactly one way to render the
// quiet state, and it never carries a hard currency emphasis.
const quietMoneyClass = "font-medium text-tertiary";

// The status-tint triple (`border-{tone}-soft bg-{tone}-soft text-{tone}`) is the
// canonical `Surface` semantic tone map. Reuse it so checkout notice/status
// surfaces tint from the same source of truth instead of a duplicated lookup.
const toneClasses = surfaceSemanticToneClasses;

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

// Designed empty/placeholder state for a line thumbnail with no image. Shared by
// `CheckoutSummaryLineItem` and `MarketplaceCartLineItem` so a missing image
// never renders a blank square or a jarring bare icon.
function LineItemImagePlaceholder() {
  return (
    <span className="flex h-full w-full items-center justify-center bg-surface-2 text-tertiary" aria-hidden="true">
      <Icon name="image" size="md" tone="tertiary" />
    </span>
  );
}

function CheckoutLinePrice({ item }: { item: CheckoutSummaryItem }) {
  const state = item.priceState ?? "exact";

  if (state === "deferred") {
    return (
      <div className={cx("text-right text-xs leading-5", quietMoneyClass)}>
        {item.deferredPriceLabel ?? "Priced at checkout"}
      </div>
    );
  }

  if (item.price === undefined || item.price === null) {
    return null;
  }

  return (
    <div className="text-right text-sm font-semibold tabular-nums text-foreground">
      {state === "indicative" ? (
        <span className="mr-1 align-baseline text-xs font-medium text-secondary">
          {item.indicativePrefix ?? "from"}
        </span>
      ) : null}
      {item.price}
    </div>
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
            <Image
              src={item.image.src}
              alt={item.image.alt}
              fit="cover"
              loading="lazy"
              fallback={<LineItemImagePlaceholder />}
            />
          ) : (
            <LineItemImagePlaceholder />
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
      <CheckoutLinePrice item={item} />
    </div>
  );
}

export interface CheckoutTotalsProps extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  lines: CheckoutSummaryLine[];
  totalLabel: ReactNode;
  total: ReactNode;
  currency?: ReactNode;
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
  /** Alias for {@link CheckoutTotalsProps.deferred}. */
  pending?: boolean;
}

export function CheckoutTotals({
  lines,
  totalLabel,
  total,
  currency,
  totalCaption,
  deferred = false,
  pending = false,
  ...rest
}: CheckoutTotalsProps) {
  const isQuiet = deferred || pending;

  return (
    <dl {...rest} className="grid gap-2">
      {lines.map((line, index) => (
        <div key={index} className="flex items-start justify-between gap-4 text-sm leading-5">
          <dt className={cx(line.muted ? "text-secondary" : "text-foreground")}>{line.label}</dt>
          <dd className="text-right font-medium tabular-nums text-foreground">{line.value}</dd>
        </div>
      ))}
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4 border-t border-muted pt-3">
        <dt className="text-base font-semibold text-foreground">{totalLabel}</dt>
        <dd
          className={cx(
            "text-right leading-tight tabular-nums",
            isQuiet ? cx("text-base", quietMoneyClass) : "text-xl font-bold text-foreground",
          )}
        >
          {currency && !isQuiet ? (
            <span className="mr-1 align-baseline text-xs font-medium text-secondary">{currency}</span>
          ) : null}
          {total}
        </dd>
        {totalCaption ? <p className="col-span-2 m-0 text-xs leading-5 text-tertiary">{totalCaption}</p> : null}
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
  totalCaption?: ReactNode;
  deferred?: boolean;
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
  totalCaption,
  deferred = false,
  actions,
  reassurance,
  ...rest
}: CheckoutSummaryPanelProps) {
  return (
    <Surface {...rest} element="section" tone="subtle">
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
        <CheckoutTotals
          lines={totals}
          totalLabel={totalLabel}
          total={total}
          currency={currency}
          totalCaption={totalCaption}
          deferred={deferred}
        />
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
    </Surface>
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
      {/* list-none removes the native disclosure marker in WebKit; marker:hidden covers
          other engines. The element remains keyboard-operable as <summary> and the
          custom chevron gives the visual expand/collapse cue. focus-ring applies a
          box-shadow outline on :focus-visible so keyboard users see a clear ring. */}
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-tokenLg px-4 py-3 text-left marker:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-accent">{label}</span>
          <span className="block text-xs leading-5 text-secondary">{collapsedSummary}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-right text-lg font-bold tabular-nums text-foreground">
          {total}
        </span>
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
    <Grid {...rest} templateColumns="minmax(0,1fr) 24rem" stackUntil="lg" gap={{ base: 5, lg: 6 }}>
      <Stack gap={5} minWidth="0">
        {mobileSummary}
        {/* stickyAction renders before main in the DOM so keyboard/screen-reader
            focus order stays correct: the sticky bar is encountered naturally after
            the mobile summary disclosure and before the step forms, matching the
            visual reading order. CSS sticky positioning keeps it pinned visually
            without lifting it out of the document flow. */}
        {stickyAction}
        {main}
      </Stack>
      <aside aria-label={summaryLabel} className="hidden min-w-0 lg:block">
        <div className="sticky top-20">{desktopSummary}</div>
      </aside>
    </Grid>
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
    <Stack {...rest} element="section" gap={3}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="m-0 text-xl font-semibold leading-7 text-foreground">{title}</h2>
          {description ? <p className="m-0 mt-1 text-sm leading-5 text-secondary">{description}</p> : null}
        </div>
        {badge}
      </div>
      <Stack gap={3}>{children}</Stack>
    </Stack>
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
      <Grid columns={{ base: 1, sm: 2 }} gap={2}>
        {actions}
      </Grid>
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
    <Surface {...rest} tone={tone}>
      <IconRow
        gap={3}
        nudge={false}
        icon={
          <Icon
            name={icon}
            size="sm"
            tone={
              tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "success" ? "success" : "accent"
            }
          />
        }
      >
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? <div className="mt-1 text-sm leading-5 text-secondary">{description}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </IconRow>
    </Surface>
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
          <Stack gap={3}>
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
          </Stack>
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
    <Surface {...rest} element="section" tone={tone} padding={5}>
      <Stack gap={3}>
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
          <Grid columns={{ base: 1, sm: 3 }} gap={3}>
            {nextSteps.map((step, index) => (
              <div key={index} className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {step.icon ? <Icon name={step.icon} size="sm" tone="accent" /> : null}
                  {step.title}
                </div>
                <div className="mt-1 text-sm leading-5 text-secondary">{step.description}</div>
              </div>
            ))}
          </Grid>
        ) : null}
        {actions ? (
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {actions}
          </div>
        ) : null}
      </Stack>
    </Surface>
  );
}

export interface CheckoutStickyActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  totalLabel: ReactNode;
  total: ReactNode;
  context?: ReactNode;
  /** Canonical reassurance slot — pass a `SecurePaymentIndicator`. */
  reassurance?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  mobileOffset?: "navigation" | "none";
  /** Accessible label for the bar region. Defaults to `"Checkout actions"`. */
  label?: string;
}

export function CheckoutStickyActionBar({
  totalLabel,
  total,
  context,
  reassurance,
  primaryAction,
  secondaryAction,
  mobileOffset = "navigation",
  label = "Checkout actions",
  ...rest
}: CheckoutStickyActionBarProps) {
  return (
    <div
      {...rest}
      role="region"
      aria-label={label}
      className={cx(
        "sticky z-sticky rounded-tokenLg border border-muted bg-background/overlay px-3 py-2 shadow-tokenLg backdrop-blur-xl md:hidden",
        mobileOffset === "navigation" ? "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]" : "bottom-0",
      )}
    >
      <Stack gap={3}>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">{totalLabel}</div>
            {context ? <div className="text-xs leading-5 text-secondary">{context}</div> : null}
            {reassurance ? <div className="mt-1">{reassurance}</div> : null}
          </div>
          <div className="text-right text-xl font-bold tabular-nums text-foreground">{total}</div>
        </div>
        <Grid columns={secondaryAction ? 2 : 1} gap={2} data-primary-action-count="1">
          {secondaryAction}
          {primaryAction}
        </Grid>
      </Stack>
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
                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-tertiary">{label}</div>
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

// Action-hierarchy helpers. These make "one primary action per surface"
// enforceable rather than conventional: the single `primary` slot stamps
// `data-primary-action-count="1"` (the contract the marketplace tests assert),
// and arranges the primary, secondary, and low-emphasis controls in the correct
// reading order — primary leads on a row, leads at the bottom of a stack — with
// canonical spacing. A surface that needs two primaries cannot express it
// through these helpers; it must pass exactly one node to `primary`.

export interface ActionRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  /** The single primary action for the surface. Renders last (right) so it reads as the commit. */
  primary?: ReactNode;
  /** Standard secondary actions (navigation, edit). */
  secondary?: ReactNode;
  /** Low-emphasis actions (ghost Remove, undo). Rendered first/quietest. */
  lowEmphasis?: ReactNode;
  /** Horizontal alignment of the cluster. Defaults to `end`. */
  align?: "start" | "end" | "between";
}

const actionAlignClasses: Record<NonNullable<ActionRowProps["align"]>, string> = {
  start: "justify-start",
  end: "justify-end",
  between: "justify-between",
};

export function ActionRow({ primary, secondary, lowEmphasis, align = "end", ...rest }: ActionRowProps) {
  return (
    <div
      {...rest}
      className={cx("flex flex-wrap items-center gap-2", actionAlignClasses[align])}
      data-primary-action-count={primary ? "1" : "0"}
    >
      {lowEmphasis}
      {secondary}
      {primary}
    </div>
  );
}

export interface ActionStackProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  /** The single primary action for the surface. Renders first (top) so it leads the stack. */
  primary?: ReactNode;
  /** Standard secondary actions (navigation, edit). */
  secondary?: ReactNode;
  /** Low-emphasis actions (ghost Remove, undo). Rendered last/quietest. */
  lowEmphasis?: ReactNode;
}

export function ActionStack({ primary, secondary, lowEmphasis, ...rest }: ActionStackProps) {
  return (
    <div {...rest} className="grid gap-2" data-primary-action-count={primary ? "1" : "0"}>
      {primary}
      {secondary}
      {lowEmphasis}
    </div>
  );
}

// A documented low-emphasis, non-blocking destructive recipe. Routine edits such
// as Remove must NOT use `tone="danger"` — red is reserved for blocking
// confirmations. This forwards to the consumer-supplied control props but pins
// the canonical ghost recipe (quiet, compact, with a trailing trash icon) so
// consumers stop reaching for danger tone on every Remove.
export interface DestructiveActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  children: ReactNode;
  /** Icon for the action. Defaults to `trash`. */
  icon?: IconName;
  /** Hide the icon entirely. */
  hideIcon?: boolean;
}

export function DestructiveAction({ children, icon = "trash", hideIcon = false, ...rest }: DestructiveActionProps) {
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      className="focus-ring inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 rounded-tokenMd border border-transparent bg-transparent px-3 py-1.5 text-sm font-semibold leading-snug text-secondary transition hover:border-border hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-disabled"
    >
      {hideIcon ? null : <Icon name={icon} size="sm" tone="secondary" />}
      <span className="min-w-0">{children}</span>
    </button>
  );
}

// Single-notice helper. Takes prioritized notices and renders exactly ONE,
// encoding the §4 priority ladder (blocking > needs-review > savings > none) so
// the checkout path stops stacking a warning notice and an info notice at once.
export type CheckoutNoticePriority = "blocking" | "needs-review" | "savings" | "info";

export interface CheckoutNoticeCandidate {
  /** Priority bucket. Higher buckets win; `blocking` is highest. */
  priority: CheckoutNoticePriority;
  /** Whether this candidate currently applies. A candidate that is not active is skipped. */
  active?: boolean;
  /** The notice to render when this candidate wins. */
  notice: ReactNode;
}

const noticePriorityRank: Record<CheckoutNoticePriority, number> = {
  blocking: 3,
  "needs-review": 2,
  savings: 1,
  info: 0,
};

/** Pick the single highest-priority active notice from the candidate ladder. */
export function selectCheckoutNotice(candidates: CheckoutNoticeCandidate[]): ReactNode {
  let winner: CheckoutNoticeCandidate | undefined;

  for (const candidate of candidates) {
    if (candidate.active === false) {
      continue;
    }

    if (!winner || noticePriorityRank[candidate.priority] > noticePriorityRank[winner.priority]) {
      winner = candidate;
    }
  }

  return winner?.notice ?? null;
}

export interface CheckoutNoticeStackProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "role" | "aria-live" | "aria-atomic"
> {
  candidates: CheckoutNoticeCandidate[];
}

/**
 * Renders the single highest-priority active notice from the candidate ladder
 * (§4 priority ladder). The container is a `role="status"` live region so that
 * screen readers announce the winning notice when checkout state changes — e.g.
 * when a fulfillment review warning replaces a savings info notice. `aria-atomic`
 * ensures the entire notice is re-read, not just the changed text fragment.
 */
export function CheckoutNoticeStack({ candidates, ...rest }: CheckoutNoticeStackProps) {
  const notice = selectCheckoutNotice(candidates);

  // Keep the live region in the DOM even when empty so screen readers have a
  // stable container to observe for changes. When empty, it renders no visual
  // output but the ARIA attributes remain active.
  return (
    <div {...rest} role="status" aria-live="polite" aria-atomic="true">
      {notice}
    </div>
  );
}
