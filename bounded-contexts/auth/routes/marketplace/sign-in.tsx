import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import {
  completeBrowserAuthentication,
  createAuthRequestApiClient,
} from "../../route-support/browser-auth";
import { SignInPage } from "../../customer/sign-in-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Sign In | Marketplace" });

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createAuthRequestApiClient(request);
  const result = await api.signInWithPassword<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  return completeBrowserAuthentication(request, result, {
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
  });
}

export default function MarketplaceSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
