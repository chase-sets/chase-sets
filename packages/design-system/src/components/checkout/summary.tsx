import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, Stack, Surface } from "../../primitives/layout";
import { Image } from "../data-display/image";
import { CheckoutStatusBadge, quietMoneyClass } from "./shared";
import type { CheckoutPrimitiveTone, CheckoutSummaryLine } from "./shared";

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
    <div className="text-right text-sm font-semibold text-foreground">
      {state === "indicative" ? (
        <span className="mr-1 align-baseline text-xs font-medium text-secondary">
          {item.indicativePrefix ?? "from"}
        </span>
      ) : null}
      <span className="font-mono tabular-nums">{item.price}</span>
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
