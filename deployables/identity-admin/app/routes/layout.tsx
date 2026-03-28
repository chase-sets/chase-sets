import { Outlet, useLocation } from "react-router";
import { IdentityAdminLayout } from "@chase-sets/identity/web";

function resolveActiveKey(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || "accounts";
}

export default function IdentityAdminLayoutRoute() {
  const location = useLocation();
  return (
    <IdentityAdminLayout activeKey={resolveActiveKey(location.pathname)}>
      <Outlet />
    </IdentityAdminLayout>
  );
}
