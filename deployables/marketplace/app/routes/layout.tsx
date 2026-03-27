import { Outlet } from "react-router";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";

export default function MarketplaceLayoutRoute() {
  return (
    <DiscoveryShellLayout activeKey="search">
      <Outlet />
    </DiscoveryShellLayout>
  );
}
