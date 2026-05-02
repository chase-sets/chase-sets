import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { RegisterPage } from "../../features/registration/ui/register-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.register! });

export const action = marketplaceAuthHost.createRegisterAction();

export default function MarketplaceRegisterRoute() {
  const actionData = useActionData<typeof action>();
  return (
    <RegisterPage
      errorMessage={actionData && "error" in actionData ? actionData.error : null}
      notice={actionData && "status" in actionData ? actionData : null}
    />
  );
}

