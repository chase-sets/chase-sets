import { resolveWebHostActiveKeyAcrossSlots, resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { AccountMenuItem, NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./context-registry";

type MarketplaceNavActor = Readonly<{ permissions?: readonly string[]; roleKey?: string | null }> | null | undefined;
type MarketplaceNavOptions = Readonly<{ cartCount?: number }>;

export function resolveMarketplaceRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "marketplace-web");
}

// The deployable supplies only the actor, the Cart count, the bottom-bar limit and the Search default;
// owner manifests declare every item, group, order, packing priority, badge and label.
function marketplaceNavSlots({ cartCount = 0 }: MarketplaceNavOptions) {
  const dynamicValues = { "checkout.cart-count": cartCount };
  return {
    "top-nav": { dynamicValues },
    "bottom-nav": { dynamicValues, limit: 5 },
    "account-menu": {},
  } as const;
}

export function resolveMarketplaceNavItems(
  slot: "top-nav" | "bottom-nav",
  actor?: MarketplaceNavActor,
  options: MarketplaceNavOptions = {},
): NavigationItem[] {
  return resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor, marketplaceNavSlots(options)[slot]);
}

export function resolveMarketplaceAccountMenuItems(actor?: MarketplaceNavActor): AccountMenuItem[] {
  return resolveWebHostNavItems(webContextRegistry, "marketplace-web", "account-menu", actor).flatMap(
    ({ key, label, href, icon }) => (href ? [{ key, label, href, icon }] : []),
  );
}

export function resolveMarketplaceActiveKey(
  pathname: string,
  actor?: MarketplaceNavActor,
  options: MarketplaceNavOptions = {},
): string | undefined {
  return resolveWebHostActiveKeyAcrossSlots(
    webContextRegistry,
    "marketplace-web",
    marketplaceNavSlots(options),
    pathname,
    actor,
    { defaultKey: "search" },
  );
}
