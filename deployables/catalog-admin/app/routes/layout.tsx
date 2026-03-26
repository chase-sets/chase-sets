import { Outlet, useLocation } from "react-router";
import { CatalogAdminLayout } from "../../../../bounded-contexts/catalog/authoring/shell/layout";

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
