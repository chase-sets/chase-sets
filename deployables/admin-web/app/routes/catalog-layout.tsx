import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { Button, Form, Inline } from "@chase-sets/design-system";
import { CatalogAdminLayout } from "@chase-sets/catalog/web";
import { requireCatalogAdminActor } from "../auth.server";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "../host";

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
  const { actor } = useLoaderData<typeof loader>();
  const navItems = resolveAdminWebNavItems(actor, { section: "catalog" });

  return (
    <CatalogAdminLayout
      topNavItems={resolveAdminWebSectionNavItems(actor)}
      topNavActiveKey="catalog"
      activeKey={resolveActiveKey(location.pathname)}
      navItems={navItems}
      actions={
        <Inline gap={2}>
          <Form action="/catalog/sign-out" method="post" spacing="none">
            <Button type="submit" tone="secondary">
              {t("adminWeb.app.routes.catalogLayout.sign.out")}
            </Button>
          </Form>
        </Inline>
      }
    >
      <Outlet />
    </CatalogAdminLayout>
  );
}
