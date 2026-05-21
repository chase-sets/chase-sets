import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
import { BrandLink, ChaseRoot, MarketplaceShell, type NavigationItem, type ColorMode } from "@chase-sets/design-system";

export function DiscoveryShellLayout({
  activeKey = "search",
  topNavItems,
  bottomNavItems,
  onNavSelect,
  actions,
  children,
}: {
  activeKey?: string;
  topNavItems: readonly NavigationItem[];
  bottomNavItems: readonly NavigationItem[];
  onNavSelect?: (key: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

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
