import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import {
  completeBrowserAuthentication,
  createAuthRequestApiClient,
} from "../../browser-auth";
import { SignInPage } from "../../customer/sign-in-page";

export const meta: MetaFunction = () => [{ title: "Sign In | Catalog Admin" }];

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
    defaultSuccessPath: "/dimensions",
    accountSelectionPath: "/account-select",
  });
}

export default function CatalogAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
