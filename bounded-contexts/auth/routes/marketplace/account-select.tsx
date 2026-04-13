import type {
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { AccountSelectionPage } from "../../features/account-selection/ui/account-selection-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: marketplaceAuthHostConfig.titles.accountSelection,
  });

export const loader = marketplaceAuthHost.createAccountSelectionLoader();

export const action = marketplaceAuthHost.createAccountSelectionAction();

export default function MarketplaceAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountSelectionPage
      memberships={data.memberships}
      errorMessage={actionData?.error ?? null}
    />
  );
}

