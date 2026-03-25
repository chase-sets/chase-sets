import { useState } from "react";
import {
  ChaseRoot,
  MarketplaceShell,
  Text,
  type NavigationItem,
  type ColorMode,
  ViewTransition,
} from "@chase-sets/design-system";
import { ItemDetailPage } from "../item-detail/ui/item-detail-page";
import { SearchPage } from "../search/ui/search-page";
import { useMarketplaceRouter } from "./router";

const topNavItems: NavigationItem[] = [
  { key: "search", label: "Browse", icon: "search", href: "#/search" },
];

const bottomNavItems: NavigationItem[] = [
  { key: "search", label: "Browse", icon: "search", href: "#/search" },
];

export function MarketplaceApp() {
  const [colorMode] = useState<ColorMode>("system");
  const route = useMarketplaceRouter();

  return (
    <ChaseRoot colorMode={colorMode}>
      <MarketplaceShell
        brand={<Text weight="semibold">Marketplace</Text>}
        topNavItems={topNavItems}
        bottomNavItems={bottomNavItems}
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
