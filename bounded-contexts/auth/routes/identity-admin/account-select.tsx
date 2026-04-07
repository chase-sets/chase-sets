import type {
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  identityAdminAuthHost,
  identityAdminAuthHostConfig,
} from "../../host-config";
import { AccountSelectionPage } from "../../customer/account-selection-page";

export const meta: MetaFunction = () => [
  { title: identityAdminAuthHostConfig.titles.accountSelection },
];

export const loader = identityAdminAuthHost.createAccountSelectionLoader();

export const action = identityAdminAuthHost.createAccountSelectionAction();

export default function IdentityAdminAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountSelectionPage
      memberships={data.memberships}
      errorMessage={actionData?.error ?? null}
    />
  );
}
