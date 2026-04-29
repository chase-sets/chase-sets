import { useState, type ReactNode } from "react";
import {
  ChaseRoot,
  SellerBadge,
  MarketplaceShell,
  type NavigationItem,
  type ColorMode,
} from "@chase-sets/design-system";

export function DiscoveryShellLayout({
  activeKey = "search",
  topNavItems,
  bottomNavItems,
  actions,
  children,
}: {
  activeKey?: string;
  topNavItems: readonly NavigationItem[];
  bottomNavItems: readonly NavigationItem[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<SellerBadge name="Chase Sets" />}
        topNavItems={[...topNavItems]}
        bottomNavItems={[...bottomNavItems]}
        activeKey={activeKey}
        actions={actions}
      >
        {children}
      </MarketplaceShell>
    </ChaseRoot>
  );
}
