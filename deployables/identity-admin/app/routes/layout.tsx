import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLocation } from "react-router";
import { Button } from "@chase-sets/design-system";
import { IdentityAdminLayout } from "@chase-sets/identity/web";
import { requireIdentityAdminActor } from "../auth.server";

function resolveActiveKey(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || "accounts";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireIdentityAdminActor(request),
  };
}

export default function IdentityAdminLayoutRoute() {
  const location = useLocation();
  return (
    <IdentityAdminLayout
      activeKey={resolveActiveKey(location.pathname)}
      actions={
        <form action="/sign-out" method="post">
          <Button type="submit" tone="secondary">
            Sign Out
          </Button>
        </form>
      }
    >
      <Outlet />
    </IdentityAdminLayout>
  );
}
