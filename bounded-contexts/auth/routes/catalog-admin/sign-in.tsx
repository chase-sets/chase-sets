import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import {
  catalogAdminAuthHost,
  catalogAdminAuthHostConfig,
} from "../../host-config";
import { SignInPage } from "../../customer/sign-in-page";

export const meta: MetaFunction = () => [
  { title: catalogAdminAuthHostConfig.titles.signIn },
];

export const action = catalogAdminAuthHost.createSignInAction();

export default function CatalogAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
