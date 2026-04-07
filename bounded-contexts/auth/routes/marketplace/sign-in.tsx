import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime/web";
import { marketplaceAuthHost, marketplaceAuthHostConfig } from "../../host-config";
import { SignInPage } from "../../customer/sign-in-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.signIn });

export const action = marketplaceAuthHost.createSignInAction();

export default function MarketplaceSignInRoute() {
  const actionData = useActionData<typeof action>();
  return <SignInPage errorMessage={actionData?.error ?? null} />;
}
