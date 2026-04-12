import type {
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { catalogAdminAuthHostConfig } from "../../host-config";
import { catalogAdminAuthHost } from "../../route-support/auth-host.server";
import { AccountSelectionPage } from "../../customer/account-selection-page";

export const meta: MetaFunction = () => [
  { title: catalogAdminAuthHostConfig.titles.accountSelection },
];

export const loader = catalogAdminAuthHost.createAccountSelectionLoader();

export const action = catalogAdminAuthHost.createAccountSelectionAction();

export default function CatalogAdminAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountSelectionPage
      memberships={data.memberships}
      errorMessage={actionData?.error ?? null}
    />
  );
}
