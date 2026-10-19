import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { BottomNav, Breadcrumbs, Button, SideNav, TopNav, type NavigationItem } from "../../components/actions";
import { NavigationDrawer } from "../../components/feedback";
import { SkipLink, layoutWidthClasses, type LayoutWidth } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { Page } from "./page-layouts";
import { useSearchRowPhase } from "./search-row-phase";

function shellGeometryClasses(hasBottomNavigation: boolean, hasSearch = false, hasSectionBar = false): string {
  return cx(
    hasSearch
      ? "[--shell-header-height:7.75rem] md:[--shell-header-height:4rem]"
      : hasSectionBar
        ? "[--shell-header-height:7rem] lg:[--shell-header-height:4rem]"
        : "[--shell-header-height:4rem]",
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
  /**
   * Opt-in for the below-md collapse-on-scroll search row. The destructuring
   * default `false` is the single owner-side arming expression: callers that
   * omit it render byte-identically to a shell without the behavior.
   */
  collapseSearchOnScroll?: boolean;
  /**
   * Canonical pathname of the active matched route (never a raw URL spelling
   * and never pathname+search+hash); the shell compares it once against the
   * registered result route to resolve the search-row scroll policy.
   */
  routeIdentity?: string;
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
  collapseSearchOnScroll = false,
  routeIdentity,
}: MarketplaceShellProps) {
  const content = <div className="space-y-6">{children}</div>;
  const hasBottomNavigation = bottomNavItems.length > 0;
  const { phase: searchRowPhase, headerRef } = useSearchRowPhase({
    enabled: collapseSearchOnScroll,
    hasSearch: Boolean(search),
    routeIdentity: routeIdentity ?? "",
  });
  const searchRowState = searchRowPhase === "inert" ? undefined : searchRowPhase;
  // TopNav receives the visual row state for every render of an opted-in shell
  // with a search slot — including the inert phase, whose visuals are the
  // expanded ones with exact-main geometry through TopNav's max-md scoping — so
  // the search control's DOM structure is stable across server render,
  // hydration, phase changes, and md crossings and the control never remounts.
  const topNavSearchRowState =
    collapseSearchOnScroll && search ? (searchRowPhase === "collapsed" ? "collapsed" : "expanded") : undefined;
  const topNav = (
    <TopNav
      brand={brand}
      items={topNavItems}
      activeKey={activeKey}
      onSelect={onNavSelect}
      search={search}
      actions={actions}
      width={width}
      searchRowState={topNavSearchRowState}
    />
  );

  return (
    <div
      data-search-row-state={searchRowState}
      className={cx(
        "min-h-screen bg-background",
        shellGeometryClasses(hasBottomNavigation, Boolean(search)),
        // The collapsed geometry override rides the same element as the state
        // attribute: the variant's attribute name is the exact string published
        // above, so the class-plus-attribute selector strictly outranks the
        // bare-class declaration from shellGeometryClasses.
        collapseSearchOnScroll && "data-[search-row-state=collapsed]:[--shell-header-height:4rem]",
      )}
    >
      <SkipLink />
      {collapseSearchOnScroll ? (
        // display:contents wrapper exists only to hand the hook the exact header
        // element for live focus containment; it renders no box of its own.
        <div ref={headerRef} className="contents">
          {topNav}
        </div>
      ) : (
        topNav
      )}
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
  sectionsLabel?: string;
  currentSectionLabel?: string;
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

function findAdminNavigationTrail(navItems: NavigationItem[], activeKey: string | undefined): NavigationItem[] {
  if (!activeKey) {
    return [];
  }

  for (const item of navItems) {
    if (item.key === activeKey) {
      return [item];
    }

    if (item.children?.length) {
      const childTrail = findAdminNavigationTrail(item.children, activeKey);
      if (childTrail.length > 0) {
        return [item, ...childTrail];
      }
    }
  }

  return [];
}

export function AdminShell({
  brand,
  topNavItems = [],
  topNavActiveKey,
  navItems,
  activeKey,
  actions,
  moreLabel = "More",
  sectionsLabel = "Sections",
  currentSectionLabel = "Current section",
  children,
  width = "full",
}: AdminShellProps) {
  const hasLocalNav = navItems.length > 0;
  const mobileNavItems = compactAdminMobileNavItems(navItems, activeKey, moreLabel);
  const sectionTrail = findAdminNavigationTrail(navItems, activeKey);
  const [sectionsOpen, setSectionsOpen] = useState(false);

  // Route selection re-renders the shell with the new activeKey; the modal
  // drawer's links navigate without firing onOpenChange, so close on that signal.
  useEffect(() => {
    setSectionsOpen(false);
  }, [activeKey]);

  return (
    <div
      className={cx("min-h-screen bg-background", shellGeometryClasses(mobileNavItems.length > 0, false, hasLocalNav))}
    >
      <SkipLink />
      <TopNav
        brand={brand}
        items={topNavItems}
        activeKey={topNavActiveKey ?? activeKey}
        actions={actions}
        mobileActionsLabel="Admin menu"
        width={width}
      />
      {hasLocalNav ? (
        <div
          data-admin-section-bar="true"
          className="sticky top-16 z-sticky border-b border-muted bg-background/overlay px-4 backdrop-blur-xl lg:hidden"
        >
          <div className={cx("mx-auto flex h-12 w-full items-center gap-3", layoutWidthClasses[width])}>
            <div className="hidden md:block">
              <NavigationDrawer
                trigger={
                  <Button tone="secondary" size="sm" leadingIcon="menu">
                    {sectionsLabel}
                  </Button>
                }
                label={sectionsLabel}
                items={navItems}
                activeKey={activeKey}
                open={sectionsOpen}
                onOpenChange={setSectionsOpen}
              />
            </div>
            {sectionTrail.length > 0 ? (
              <Breadcrumbs
                ariaLabel={currentSectionLabel}
                items={sectionTrail.map((item, index) => ({
                  label: item.label,
                  href: index < sectionTrail.length - 1 ? item.href : undefined,
                }))}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <main
        id="main-content"
        tabIndex={-1}
        className={cx(
          "mx-auto min-h-[calc(100vh-var(--shell-header-height,4rem))] w-full gap-6 px-4 py-5 pb-24 lg:py-6 lg:pb-8",
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
