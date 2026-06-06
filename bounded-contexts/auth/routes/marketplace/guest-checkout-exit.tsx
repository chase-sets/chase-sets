import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";

export const action = marketplaceAuthHost.createSignOutAction({ returnTo: "/search" });

export default function MarketplaceGuestCheckoutExitRoute() {
  return null;
}
