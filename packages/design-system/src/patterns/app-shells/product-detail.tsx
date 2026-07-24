import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { Sidebar } from "../../components/feedback";

const MOBILE_DOCK_HEIGHT_VAR = "--product-detail-mobile-dock-height";
const MOBILE_DOCK_CLEARANCE_VAR = "--product-detail-mobile-dock-clearance";
const SHELL_BOTTOM_NAV_HEIGHT_VAR = "--shell-bottom-nav-height";

function restoreRootProperty(root: HTMLElement, property: string, previousValue: string) {
  if (previousValue) {
    root.style.setProperty(property, previousValue);
  } else {
    root.style.removeProperty(property);
  }
}

function useMobileDockClearance() {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof document === "undefined" || typeof ResizeObserver === "undefined") {
      return;
    }

    const root = document.documentElement;
    const previousDockHeight = root.style.getPropertyValue(MOBILE_DOCK_HEIGHT_VAR);
    const previousBottomNavHeight = root.style.getPropertyValue(SHELL_BOTTOM_NAV_HEIGHT_VAR);
    const previousClearance = root.style.getPropertyValue(MOBILE_DOCK_CLEARANCE_VAR);
    const previousScrollPadding = root.style.scrollPaddingBottom;

    // MarketplaceShell/AdminShell own --shell-bottom-nav-height on their own
    // subtree (SSR-safe, no literal offset for descendants). document.documentElement
    // is that subtree's ancestor, never its descendant, so a var() reference set
    // directly on root always resolves the fallback instead of the shell's real
    // 5.25rem -> 0px breakpoint value. This dock IS a shell descendant, so it
    // inherits the real value correctly; mirror that resolved value onto root
    // instead of letting root guess at its own unset copy.
    const syncBottomNavHeight = () => {
      const resolved = getComputedStyle(node).getPropertyValue(SHELL_BOTTOM_NAV_HEIGHT_VAR).trim();
      root.style.setProperty(SHELL_BOTTOM_NAV_HEIGHT_VAR, resolved || "0px");
    };

    const applyClearance = (heightPx: number) => {
      root.style.setProperty(MOBILE_DOCK_HEIGHT_VAR, `${heightPx}px`);
      root.style.setProperty(
        MOBILE_DOCK_CLEARANCE_VAR,
        `calc(var(${SHELL_BOTTOM_NAV_HEIGHT_VAR}, 0px) + ${heightPx}px + env(safe-area-inset-bottom))`,
      );
      root.style.scrollPaddingBottom = `var(${MOBILE_DOCK_CLEARANCE_VAR})`;
    };

    syncBottomNavHeight();
    applyClearance(node.getBoundingClientRect().height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        syncBottomNavHeight();
        applyClearance(entry.contentRect.height);
      }
    });
    observer.observe(node);

    // The bottom-nav breakpoint can flip (e.g. rotating through md) without the
    // dock's own rendered height changing, so ResizeObserver alone would miss it.
    const handleViewportChange = () => {
      syncBottomNavHeight();
      applyClearance(node.getBoundingClientRect().height);
    };
    window.addEventListener("resize", handleViewportChange);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      restoreRootProperty(root, MOBILE_DOCK_HEIGHT_VAR, previousDockHeight);
      restoreRootProperty(root, SHELL_BOTTOM_NAV_HEIGHT_VAR, previousBottomNavHeight);
      restoreRootProperty(root, MOBILE_DOCK_CLEARANCE_VAR, previousClearance);
      if (previousScrollPadding) {
        root.style.scrollPaddingBottom = previousScrollPadding;
      } else {
        root.style.removeProperty("scroll-padding-bottom");
      }
    };
  }, []);

  return ref;
}

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
  label?: string;
}

export function MarketplaceProductMobileActionDock({
  children,
  label = "Mobile commerce actions",
}: MarketplaceProductMobileActionDockProps) {
  const dockRef = useMobileDockClearance();

  return (
    <div
      ref={dockRef}
      role="region"
      aria-label={label}
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
