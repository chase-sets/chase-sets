import { useState, type ReactNode } from "react";
import {
  ChaseRoot,
  MarketplaceShell,
  Text,
  type NavigationItem,
  type ColorMode,
} from "@chase-sets/design-system";
import { marketplaceBottomNavItems, marketplaceTopNavItems } from "./nav";

export function DiscoveryShellLayout({
  activeKey = "search",
  topNavItems = marketplaceTopNavItems,
  bottomNavItems = marketplaceBottomNavItems,
  children,
}: {
  activeKey?: string;
  topNavItems?: NavigationItem[];
  bottomNavItems?: NavigationItem[];
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<Text weight="semibold">Marketplace</Text>}
        topNavItems={topNavItems}
        bottomNavItems={bottomNavItems}
        activeKey={activeKey}
      >
        {children}
      </MarketplaceShell>
    </ChaseRoot>
  );
}
