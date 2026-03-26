import { useState } from "react";
import {
  ChaseRoot,
  MarketplaceShell,
  Text,
  type ColorMode,
  ViewTransition,
} from "@chase-sets/design-system";
import { ItemDetailPage } from "../items/ui/item-detail-page";
import { SearchPage } from "../items/ui/search-page";
import { marketplaceBottomNavItems, marketplaceTopNavItems } from "./nav";
import { useMarketplaceRouter } from "./router";

export function MarketplaceApp() {
  const [colorMode] = useState<ColorMode>("system");
  const route = useMarketplaceRouter();

  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<Text weight="semibold">Marketplace</Text>}
        topNavItems={marketplaceTopNavItems}
        bottomNavItems={marketplaceBottomNavItems}
        activeKey={route.page}
      >
        <ViewTransition transitionKey={`${route.page}:${route.id ?? ""}`} preset="page">
          {route.page === "items" && route.id ? (
            <ItemDetailPage id={route.id} />
          ) : (
            <SearchPage />
          )}
        </ViewTransition>
      </MarketplaceShell>
    </ChaseRoot>
  );
}

