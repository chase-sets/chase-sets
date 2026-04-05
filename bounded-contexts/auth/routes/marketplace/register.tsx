import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import {
  completeBrowserAuthentication,
  createAuthRequestApiClient,
} from "../../browser-auth";
import { RegisterPage } from "../../customer/register-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Register | Marketplace" });

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createAuthRequestApiClient(request);
  const result = await api.register<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  return completeBrowserAuthentication(request, result, {
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
  });
}

export default function MarketplaceRegisterRoute() {
  const actionData = useActionData<typeof action>();
  return <RegisterPage errorMessage={actionData?.error ?? null} />;
}
