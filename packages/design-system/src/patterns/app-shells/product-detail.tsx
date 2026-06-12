import type { HTMLAttributes, ReactNode } from "react";
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
}

export function MarketplaceProductMobileActionDock({ children }: MarketplaceProductMobileActionDockProps) {
  return (
    <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-sticky mt-6 xl:hidden">
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
  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)_24rem] xl:items-start 2xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)_26rem]">
        <div className="order-2 xl:order-1 xl:col-start-1 xl:row-start-1">{media}</div>
        <div className="contents min-w-0 xl:order-2 xl:block">
          <div className="order-1 min-w-0">{summary}</div>
          <div className="order-3 min-w-0 xl:mt-6">{market}</div>
        </div>
        <div className="order-4 min-w-0 xl:col-span-2 xl:col-start-1 xl:row-start-2">{children}</div>
        <MarketplaceProductCommerceRail>{commerce}</MarketplaceProductCommerceRail>
      </div>
      {mobileActionBar ? (
        <MarketplaceProductMobileActionDock>{mobileActionBar}</MarketplaceProductMobileActionDock>
      ) : null}
    </>
  );
}

export interface MarketplaceMetricItem {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}

export interface MarketplaceMetricStripProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  items: MarketplaceMetricItem[];
}

export function MarketplaceMetricStrip({ items, ...rest }: MarketplaceMetricStripProps) {
  return (
    <div {...rest} className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
      {items.map((item, index) => (
        <div key={index} className="rounded-tokenLg border border-muted bg-surface p-3 shadow-tokenSm">
          <div className="text-xs font-semibold uppercase text-secondary">{item.label}</div>
          <div className="mt-1 font-heading text-lg font-semibold text-foreground md:text-xl">{item.value}</div>
          {item.detail ? <div className="mt-1 text-xs text-secondary">{item.detail}</div> : null}
        </div>
      ))}
    </div>
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
