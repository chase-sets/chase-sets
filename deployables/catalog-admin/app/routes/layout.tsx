import { Outlet, useLocation } from "react-router";
import { CatalogAdminLayout } from "@chase-sets/catalog-authoring/web";

function resolveActiveKey(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || "dimensions";
}

export default function CatalogAdminLayoutRoute() {
  const location = useLocation();

  return (
    <CatalogAdminLayout activeKey={resolveActiveKey(location.pathname)}>
      <Outlet />
    </CatalogAdminLayout>
  );
}
