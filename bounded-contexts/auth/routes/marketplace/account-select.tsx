import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import {
  completeBrowserAuthentication,
  createAuthRequestApiClient,
  requireAccountSelectionTokenOrRedirect,
} from "../../server";
import { AccountSelectionPage } from "../../customer/account-selection-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Select Account | Marketplace" });

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  const selectionToken = requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/account",
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
    fallbackPath: "/account",
  });
  const result = await api.completeAccountSelection<{ sessionToken?: string }>({
    selectionToken,
    accountId: formData.get("accountId"),
  });

  return completeBrowserAuthentication(request, result, {
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
  });
}

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
