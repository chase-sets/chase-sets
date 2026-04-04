import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLocation } from "react-router";
import { Button } from "@chase-sets/design-system";
import { CatalogAdminLayout } from "@chase-sets/catalog/web";
import { createCatalogAdminPrimaryNavItems } from "../context-shell.generated";
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
  const navItems = createCatalogAdminPrimaryNavItems();

  return (
    <CatalogAdminLayout
      activeKey={resolveActiveKey(location.pathname)}
      navItems={navItems}
      actions={
        <form action="/sign-out" method="post">
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

