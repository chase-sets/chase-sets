import { t } from "@chase-sets/localization";
import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { AdminShell, Button, ChaseRoot, Form, Inline, SellerBadge, type ColorMode } from "@chase-sets/design-system";
import { requireCommercialTermsAdminActor } from "../auth.server";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "../host";

function resolveActiveKey(_pathname: string) {
  return "commercial-terms";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireCommercialTermsAdminActor(request),
  };
}

export default function CommercialAdminLayoutRoute() {
  const location = useLocation();
  const { actor } = useLoaderData<typeof loader>();
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<SellerBadge name="Commercial Terms Ops" verified />}
        topNavItems={resolveAdminWebSectionNavItems(actor)}
        topNavActiveKey="commercial"
        navItems={resolveAdminWebNavItems(actor, { section: "commercial" })}
        activeKey={resolveActiveKey(location.pathname)}
        actions={
          <Inline gap={2}>
            <Form action="/identity/sign-out" method="post" spacing="none">
              <Button type="submit" tone="secondary">
                {t("adminWeb.app.routes.commercialLayout.sign.out")}
              </Button>
            </Form>
          </Inline>
        }
      >
        <Outlet />
      </AdminShell>
    </ChaseRoot>
  );
}
