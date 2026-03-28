import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { SignInPage } from "@chase-sets/identity/web";
import { createIdentityServerApiClient } from "../api.server";
import { completeAuthentication } from "../auth.server";

export const meta: MetaFunction = () => [{ title: "Sign In | Identity Admin" }];

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createIdentityServerApiClient(request);
  const result = await api.signInWithPassword<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  return completeAuthentication(request, result);
}

export default function IdentityAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
