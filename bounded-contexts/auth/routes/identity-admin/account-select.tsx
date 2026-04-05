import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  completeBrowserAuthentication,
  createAuthRequestApiClient,
  requireAccountSelectionTokenOrRedirect,
} from "../../server";
import { AccountSelectionPage } from "../../customer/account-selection-page";

export const meta: MetaFunction = () => [
  { title: "Select Account | Identity Admin" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  const selectionToken = requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/accounts",
  });

  return api.resolveAccountSelection<{
    memberships: { accountId: string; roleKey: string }[];
  }>({
    selectionToken,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createAuthRequestApiClient(request);
  const selectionToken = requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/accounts",
  });
  const result = await api.completeAccountSelection<{ sessionToken?: string }>({
    selectionToken,
    accountId: formData.get("accountId"),
  });

  return completeBrowserAuthentication(request, result, {
    defaultSuccessPath: "/accounts",
    accountSelectionPath: "/account-select",
  });
}

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
