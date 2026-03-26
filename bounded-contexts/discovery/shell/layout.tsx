import { useState, type ReactNode } from "react";
import {
  ChaseRoot,
  MarketplaceShell,
  Text,
  type ColorMode,
} from "@chase-sets/design-system";
import { marketplaceBottomNavItems, marketplaceTopNavItems } from "./nav";

export function DiscoveryShellLayout({
  activeKey = "search",
  children,
}: {
  activeKey?: string;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<Text weight="semibold">Marketplace</Text>}
        topNavItems={marketplaceTopNavItems}
        bottomNavItems={marketplaceBottomNavItems}
        activeKey={activeKey}
      >
        {children}
      </MarketplaceShell>
    </ChaseRoot>
  );
}
