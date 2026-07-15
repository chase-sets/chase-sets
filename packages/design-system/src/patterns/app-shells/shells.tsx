import type { ReactNode } from "react";
import { BottomNav, SideNav, TopNav, type NavigationItem } from "../../components/actions";
import { SkipLink, layoutWidthClasses, type LayoutWidth } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { Page } from "./page-layouts";

function shellGeometryClasses(hasBottomNavigation: boolean, hasSearch = false): string {
  return cx(
    hasSearch ? "[--shell-header-height:7.75rem] md:[--shell-header-height:4rem]" : "[--shell-header-height:4rem]",
    hasBottomNavigation
      ? "[--shell-bottom-nav-height:5.25rem] md:[--shell-bottom-nav-height:0px]"
      : "[--shell-bottom-nav-height:0px]",
  );
}

export interface MarketplaceShellProps {
  brand: ReactNode;
  topNavItems: NavigationItem[];
  bottomNavItems: NavigationItem[];
  activeKey?: string;
  onNavSelect?: (key: string) => void;
  actions?: ReactNode;
  search?: ReactNode;
  hero?: ReactNode;
  sidebar?: ReactNode;
  children?: ReactNode;
  width?: LayoutWidth;
}

export function MarketplaceShell({
  brand,
  topNavItems,
  bottomNavItems,
  activeKey,
  onNavSelect,
  actions,
  search,
  hero,
  sidebar,
  children,
  width = "full",
}: MarketplaceShellProps) {
  const content = <div className="space-y-6">{children}</div>;
  const hasBottomNavigation = bottomNavItems.length > 0;

  return (
    <div className={cx("min-h-screen bg-background", shellGeometryClasses(hasBottomNavigation, Boolean(search)))}>
      <SkipLink />
      <TopNav
        brand={brand}
        items={topNavItems}
        activeKey={activeKey}
        onSelect={onNavSelect}
        search={search}
        actions={actions}
        width={width}
      />
      <main id="main-content" tabIndex={-1} className="relative z-0">
        <Page width={width}>
          {hero}
          {sidebar ? (
            <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="hidden lg:block">{sidebar}</div>
              {content}
            </div>
          ) : (
            content
          )}
        </Page>
      </main>
      {hasBottomNavigation ? (
        <BottomNav items={bottomNavItems} activeKey={activeKey} onSelect={onNavSelect} width={width} />
      ) : null}
    </div>
  );
}

export interface AdminShellProps {
  brand: ReactNode;
  topNavItems?: NavigationItem[];
  topNavActiveKey?: string;
  navItems: NavigationItem[];
  activeKey?: string;
  actions?: ReactNode;
  moreLabel?: string;
  children?: ReactNode;
  width?: LayoutWidth;
}

function compactAdminMobileNavItems(
  navItems: NavigationItem[],
  activeKey: string | undefined,
  moreLabel: string,
): NavigationItem[] {
  if (navItems.length <= 4) {
    return navItems;
  }

  const primaryLimit = 3;
  const activeItem = navItems.find((item) => isAdminNavigationItemActive(item, activeKey));
  const primaryItems = navItems.slice(0, primaryLimit);
  const activeItemIsPrimary = activeItem ? primaryItems.some((item) => item.key === activeItem.key) : true;
  const visibleItems =
    activeItem && !activeItemIsPrimary ? [...navItems.slice(0, primaryLimit - 1), activeItem] : primaryItems;
  const visibleKeys = new Set(visibleItems.map((item) => item.key));
  const overflowItems = navItems.filter((item) => !visibleKeys.has(item.key));

  return [
    ...visibleItems,
    {
      key: "admin-more",
      label: moreLabel,
      icon: "menu",
      children: overflowItems,
    },
  ];
}

function isAdminNavigationItemActive(item: NavigationItem, activeKey?: string): boolean {
  return (
    item.key === activeKey || Boolean(item.children?.some((child) => isAdminNavigationItemActive(child, activeKey)))
  );
}

export function AdminShell({
  brand,
  topNavItems = [],
  topNavActiveKey,
  navItems,
  activeKey,
  actions,
  moreLabel = "More",
  children,
  width = "full",
}: AdminShellProps) {
  const hasLocalNav = navItems.length > 0;
  const mobileNavItems = compactAdminMobileNavItems(navItems, activeKey, moreLabel);

  return (
    <div className={cx("min-h-screen bg-background", shellGeometryClasses(mobileNavItems.length > 0))}>
      <SkipLink />
      <TopNav
        brand={brand}
        items={topNavItems}
        activeKey={topNavActiveKey ?? activeKey}
        actions={actions}
        mobileActionsLabel="Admin menu"
        width={width}
      />
      <main
        id="main-content"
        tabIndex={-1}
        className={cx(
          "mx-auto min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-5 pb-24 lg:py-6 lg:pb-8",
          hasLocalNav && "grid lg:grid-cols-[16rem_minmax(0,1fr)]",
          layoutWidthClasses[width],
        )}
      >
        {hasLocalNav ? (
          <div className="hidden lg:block">
            <div className="sticky top-20 self-start">
              <SideNav items={navItems} activeKey={activeKey} />
            </div>
          </div>
        ) : null}
        <div className="min-w-0 max-w-full space-y-6 overflow-x-clip">{children}</div>
      </main>
      {mobileNavItems.length > 0 ? <BottomNav items={mobileNavItems} activeKey={activeKey} width={width} /> : null}
    </div>
  );
}
