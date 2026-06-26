import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import { BrandLink, ChaseRoot, MarketplaceShell, type NavigationItem, type ColorMode } from "@chase-sets/design-system";

export function DiscoveryShellLayout({
  activeKey = "search",
  colorMode = "system",
  topNavItems,
  bottomNavItems,
  onNavSelect,
  actions,
  children,
}: {
  activeKey?: string;
  colorMode?: ColorMode;
  topNavItems: readonly NavigationItem[];
  bottomNavItems: readonly NavigationItem[];
  onNavSelect?: (key: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<BrandLink label={t("discovery.support.shellSupport.layout.chase.sets")} />}
        topNavItems={[...topNavItems]}
        bottomNavItems={[...bottomNavItems]}
        activeKey={activeKey}
        onNavSelect={onNavSelect}
        actions={actions}
      >
        {children}
      </MarketplaceShell>
    </ChaseRoot>
  );
}
