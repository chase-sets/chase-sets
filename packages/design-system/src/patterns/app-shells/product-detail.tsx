import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { Sidebar } from "../../components/feedback";

export interface MarketplaceProductDetailLayoutProps {
  summary: ReactNode;
  media: ReactNode;
  market: ReactNode;
  commerce: ReactNode;
  mobileActionBar?: ReactNode;
  children?: ReactNode;
}

export interface MarketplaceProductCommerceRailProps {
  children: ReactNode;
  label?: string;
}

export function MarketplaceProductCommerceRail({
  children,
  label = "Commerce options",
}: MarketplaceProductCommerceRailProps) {
  return (
    <div className="order-5 hidden min-w-0 xl:sticky xl:top-20 xl:order-3 xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:block xl:max-h-[calc(100dvh-5rem)] xl:self-start xl:overflow-x-hidden xl:overflow-y-auto xl:overscroll-contain xl:[scrollbar-gutter:stable]">
      <Sidebar label={label} purpose="support" width="summary">
        {children}
      </Sidebar>
    </div>
  );
}

export interface MarketplaceProductMobileActionDockProps {
  children: ReactNode;
  onDockHeightChange?: (height: number) => void;
}

// Decision 1 (#5963): the bottom offset is composed symbolically from the shell-owned
// --shell-bottom-nav-height, matching the compliant precedent in filter.tsx / status.tsx.
// --shell-bottom-nav-height is declared on the shell element (shells.tsx), a strict
// ancestor of this dock, so ordinary cascade resolves it per breakpoint with no JS
// bridge; it is never read back via getComputedStyle and republished.

export function MarketplaceProductMobileActionDock({
  children,
  onDockHeightChange,
}: MarketplaceProductMobileActionDockProps) {
  const dockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = dockRef.current;
    if (!node || !onDockHeightChange) {
      return;
    }
    // Decision 2 (#5963): measuring the dock's own box via ResizeObserver is
    // permitted — its height is not declared per breakpoint, unlike
    // --shell-bottom-nav-height / --shell-header-height.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        onDockHeightChange(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onDockHeightChange]);

  return (
    <div
      ref={dockRef}
      data-testid="product-detail-mobile-dock"
      className="sticky bottom-[calc(var(--shell-bottom-nav-height,0px)+env(safe-area-inset-bottom))] z-sticky mt-6 xl:hidden"
    >
      <div className="mx-auto max-w-3xl">{children}</div>
    </div>
  );
}

export function MarketplaceProductDetailLayout({
  summary,
  media,
  market,
  commerce,
  mobileActionBar,
  children,
}: MarketplaceProductDetailLayoutProps) {
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  // Decisions 2 and 6 (#5963): this pattern is the sole authority for dock-height
  // clearance. It publishes the dock's own measured height as
  // --product-detail-dock-height, then composes that with the shell-owned
  // --shell-bottom-nav-height *symbolically* (kept inside calc(...), never resolved
  // via getComputedStyle) into --product-detail-focus-clearance. Consumers inside this
  // subtree (e.g. Market book focus/scroll targets) apply that clearance themselves —
  // see decision 1 — so Discovery never computes or hardcodes a combined-clearance
  // literal.
  //
  // --product-detail-dock-height is published only once the dock has actually measured
  // itself. Emitting a fabricated "0px" from the first render made the server-rendered
  // document assert a measured geometry it does not have: every reader — including the
  // clearance below and any evidence probe — saw a well-formed "0px" that was
  // indistinguishable from a dock genuinely measured at zero. Leaving the property
  // undefined until the ResizeObserver reports keeps the composed clearance on its
  // declared var(..., 0px) fallback (identical resolved behavior before measurement)
  // while making "not measured yet" observably distinct from "measured as zero".
  const focusClearanceStyle = {
    ...(dockHeight === null ? null : { "--product-detail-dock-height": `${dockHeight}px` }),
    "--product-detail-focus-clearance":
      "calc(var(--product-detail-dock-height, 0px) + var(--shell-bottom-nav-height, 0px) + env(safe-area-inset-bottom))",
  } as CSSProperties;

  return (
    <>
      <div
        style={focusClearanceStyle}
        className="grid gap-6 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)_24rem] xl:items-start 2xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)_26rem]"
      >
        <div className="order-2 xl:order-1 xl:col-start-1 xl:row-start-1">{media}</div>
        <div className="contents min-w-0 xl:order-2 xl:block">
          <div className="order-1 min-w-0">{summary}</div>
          <div className="order-3 min-w-0 xl:mt-6">{market}</div>
        </div>
        <div className="order-4 min-w-0 xl:col-span-2 xl:col-start-1 xl:row-start-2">{children}</div>
        <MarketplaceProductCommerceRail>{commerce}</MarketplaceProductCommerceRail>
      </div>
      {mobileActionBar ? (
        <MarketplaceProductMobileActionDock onDockHeightChange={setDockHeight}>
          {mobileActionBar}
        </MarketplaceProductMobileActionDock>
      ) : null}
    </>
  );
}

export interface MarketplaceMarketSummaryFact {
  label: ReactNode;
  value: ReactNode;
}

export interface MarketplaceMarketSummaryProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  priceLabel?: ReactNode;
  price: ReactNode;
  facts: MarketplaceMarketSummaryFact[];
  note?: ReactNode;
}

export function MarketplaceMarketSummary({
  priceLabel = "Lowest ask",
  price,
  facts,
  note,
  ...rest
}: MarketplaceMarketSummaryProps) {
  return (
    <div {...rest} className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-secondary">{priceLabel}</div>
          <div className="mt-1 font-heading text-2xl font-semibold text-foreground">{price}</div>
          {note ? <div className="mt-1 text-sm text-secondary">{note}</div> : null}
        </div>
        {facts.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:min-w-[22rem]">
            {facts.map((fact, index) => (
              <div key={index}>
                <div className="text-xs font-semibold uppercase text-secondary">{fact.label}</div>
                <div className="mt-1 text-sm font-semibold text-foreground">{fact.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
