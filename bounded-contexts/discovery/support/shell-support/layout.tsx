import { useState, type ReactNode } from "react";
import {
  ChaseRoot,
  MarketplaceShell,
  Text,
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
        brand={<Text weight="semibold">Marketplace</Text>}
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
