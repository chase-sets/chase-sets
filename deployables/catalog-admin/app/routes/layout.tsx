import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLocation } from "react-router";
import { CatalogAdminLayout } from "@chase-sets/catalog-authoring/web";
import { requireCatalogAdminActor } from "../auth.server";

function resolveActiveKey(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || "dimensions";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireCatalogAdminActor(request, "catalog.view"),
  };
}

export default function CatalogAdminLayoutRoute() {
  const location = useLocation();

  return (
    <CatalogAdminLayout activeKey={resolveActiveKey(location.pathname)}>
      <Outlet />
    </CatalogAdminLayout>
  );
}
