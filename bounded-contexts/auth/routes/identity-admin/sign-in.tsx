import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { createAuthRequestApiClient } from "../../client";
import { completeBrowserAuthentication } from "../../server";
import { SignInPage } from "../../web";

export const meta: MetaFunction = () => [{ title: "Sign In | Identity Admin" }];

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
    defaultSuccessPath: "/accounts",
    accountSelectionPath: "/account-select",
  });
}

export default function IdentityAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
