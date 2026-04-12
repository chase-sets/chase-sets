import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { identityAdminAuthHostConfig } from "../../host-config";
import { identityAdminAuthHost } from "../../route-support/auth-host.server";
import { SignInPage } from "../../customer/sign-in-page";

export const meta: MetaFunction = () => [
  { title: identityAdminAuthHostConfig.titles.signIn },
];

export const action = identityAdminAuthHost.createSignInAction();

export default function IdentityAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
