import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { AccountSelectionPage } from "@chase-sets/identity/web";
import { createIdentityServerApiClient } from "../api.server";
import {
  completeAuthentication,
  requireAccountSelectionToken,
} from "../auth.server";

export const meta: MetaFunction = () => [{ title: "Select Account | Identity Admin" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
  const selectionToken = requireAccountSelectionToken(request);
  return api.resolveAccountSelection<{
    memberships: { accountId: string; roleKey: string }[];
  }>({
    selectionToken,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createIdentityServerApiClient(request);
  const selectionToken = requireAccountSelectionToken(request);
  const result = await api.completeAccountSelection<{ sessionToken?: string }>({
    selectionToken,
    accountId: formData.get("accountId"),
  });

  return completeAuthentication(request, result);
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
