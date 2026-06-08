import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { accessAdminAuthHost } from "../../support/route-support/auth-host.server";
import { accessAdminAuthHostConfig } from "../../support/route-support/host-config";
import { AccountSelectionPage } from "../../features/account-selection/ui/account-selection-page";

export const meta: MetaFunction = () => [{ title: accessAdminAuthHostConfig.titles.accountSelection }];

export const loader = accessAdminAuthHost.createAccountSelectionLoader();

export const action = accessAdminAuthHost.createAccountSelectionAction();

export default function AccessAdminAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return <AccountSelectionPage memberships={data.memberships} errorMessage={actionData?.error ?? null} />;
}
