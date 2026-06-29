import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { adminAuthHost } from "../../support/route-support/auth-host.server";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
import { AccountSelectionPage } from "../../features/account-selection/ui/account-selection-page";

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.accountSelection }];

export const loader = adminAuthHost.createAccountSelectionLoader();

export const action = adminAuthHost.createAccountSelectionAction();

export default function AccessAdminAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return <AccountSelectionPage memberships={data.memberships} errorMessage={actionData?.error ?? null} />;
}
