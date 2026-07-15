import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  BrandLink,
  ChaseRoot,
  MarketplaceShell,
  type ChaseRootProps,
  type NavigationItem,
  type ColorMode,
} from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { MarketplaceHeaderSearch } from "../../features/search/ui/header-search";

export function DiscoveryShellLayout({
  activeKey = "search",
  colorMode = "system",
  reducedMotion = "user",
  topNavItems,
  bottomNavItems,
  onNavSelect,
  actions,
  children,
}: {
  activeKey?: string;
  colorMode?: ColorMode;
  reducedMotion?: ChaseRootProps["reducedMotion"];
  topNavItems: readonly NavigationItem[];
  bottomNavItems: readonly NavigationItem[];
  onNavSelect?: (key: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ChaseRoot colorMode={colorMode} reducedMotion={reducedMotion} linkComponent={RouterLinkAdapter}>
      <MarketplaceShell
        brand={<BrandLink label={t("discovery.support.shellSupport.layout.chase.sets")} />}
        topNavItems={[...topNavItems]}
        bottomNavItems={[...bottomNavItems]}
        activeKey={activeKey}
        onNavSelect={onNavSelect}
        search={<MarketplaceHeaderSearch />}
        actions={actions}
      >
        {children}
      </MarketplaceShell>
    </ChaseRoot>
  );
}
