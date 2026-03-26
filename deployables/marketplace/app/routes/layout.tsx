import { Outlet } from "react-router";
import { DiscoveryShellLayout } from "../../../../bounded-contexts/discovery/shell/layout";

export default function MarketplaceLayoutRoute() {
  return (
    <DiscoveryShellLayout activeKey="search">
      <Outlet />
    </DiscoveryShellLayout>
  );
}
