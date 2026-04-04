import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { createIdentityRequestApiClient } from "@chase-sets/identity/client";
import { RegisterPage } from "@chase-sets/identity/web";
import { completeAuthentication } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Register | Marketplace" });

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createIdentityRequestApiClient(request);
  const result = await api.register<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  return completeAuthentication(request, result, {
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
  });
}

export default function MarketplaceRegisterRoute() {
  const actionData = useActionData<typeof action>();
  return <RegisterPage errorMessage={actionData?.error ?? null} />;
}
