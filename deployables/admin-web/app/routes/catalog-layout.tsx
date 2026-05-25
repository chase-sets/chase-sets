import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { Button, Inline, LinkButton } from "@chase-sets/design-system";
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
  const { actor } = useLoaderData<typeof loader>();
  const navItems = resolveAdminWebNavItems(actor, { section: "catalog" });

  return (
    <CatalogAdminLayout
      activeKey={resolveActiveKey(location.pathname)}
      navItems={navItems}
      actions={
        <Inline gap={2}>
          <LinkButton href="/experience/waitlist" tone="secondary">
            {t("adminWeb.app.routes.catalogLayout.experience")}
          </LinkButton>
          <LinkButton href="/identity/accounts" tone="secondary">
            {t("adminWeb.app.routes.catalogLayout.identity")}
          </LinkButton>
          <LinkButton href="/operations/projections" tone="secondary">
            {t("adminWeb.app.routes.catalogLayout.operations")}
          </LinkButton>
          <form action="/catalog/sign-out" method="post">
            <Button type="submit" tone="secondary">
              {t("adminWeb.app.routes.catalogLayout.sign.out")}
            </Button>
          </form>
        </Inline>
      }
    >
      <Outlet />
    </CatalogAdminLayout>
  );
}
