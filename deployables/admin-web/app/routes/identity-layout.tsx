import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { Button, Inline, LinkButton } from "@chase-sets/design-system";
import { IdentityAdminLayout } from "@chase-sets/identity/web";
import { requireIdentityAdminActor } from "../auth.server";
import { resolveAdminWebNavItems } from "../host";

function resolveActiveKey(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments[1] || "accounts";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireIdentityAdminActor(request),
  };
}

export default function IdentityAdminLayoutRoute() {
  const location = useLocation();
  const { actor } = useLoaderData<typeof loader>();

  return (
    <IdentityAdminLayout
      activeKey={resolveActiveKey(location.pathname)}
      navItems={resolveAdminWebNavItems(actor, { section: "identity" })}
      actions={
        <Inline gap={2}>
          <LinkButton href="/catalog/dimensions" tone="secondary">
            {t("adminWeb.app.routes.identityLayout.catalog")}
          </LinkButton>
          <form action="/identity/sign-out" method="post">
            <Button type="submit" tone="secondary">
              {t("adminWeb.app.routes.identityLayout.sign.out")}</Button>
          </form>
        </Inline>
      }
    >
      <Outlet />
    </IdentityAdminLayout>
  );
}
