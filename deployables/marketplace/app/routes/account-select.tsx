import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { createIdentityRequestApiClient } from "@chase-sets/identity/client";
import { AccountSelectionPage } from "@chase-sets/identity/web";
import {
  completeAuthentication,
  requireAccountSelectionToken,
} from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const selectionToken = requireAccountSelectionToken(request);
  return api.resolveAccountSelection<{
    memberships: { accountId: string; roleKey: string }[];
  }>({
    selectionToken,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createIdentityRequestApiClient(request);
  const selectionToken = requireAccountSelectionToken(request);
  const result = await api.completeAccountSelection<{ sessionToken?: string }>({
    selectionToken,
    accountId: formData.get("accountId"),
  });

  return completeAuthentication(request, result, {
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
  });
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Select Account | Marketplace" });

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
