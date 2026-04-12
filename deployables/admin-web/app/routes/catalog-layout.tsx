import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLocation } from "react-router";
import { Button } from "@chase-sets/design-system";
import { CatalogAdminLayout } from "@chase-sets/catalog/web";
import { requireCatalogAdminActor } from "../auth.server";
import { resolveAdminWebNavItems } from "../host";

function resolveActiveKey(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments[1] || "dimensions";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireCatalogAdminActor(request, "catalog.view"),
  };
}

export default function CatalogAdminLayoutRoute() {
  const location = useLocation();
  const navItems = resolveAdminWebNavItems(undefined, { section: "catalog" });

  return (
    <CatalogAdminLayout
      activeKey={resolveActiveKey(location.pathname)}
      navItems={navItems}
      actions={
        <form action="/catalog/sign-out" method="post">
          <Button type="submit" tone="secondary">
            Sign Out
          </Button>
        </form>
      }
    >
      <Outlet />
    </CatalogAdminLayout>
  );
}
