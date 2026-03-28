import type { MetaFunction } from "react-router";
import { SignInPage } from "@chase-sets/identity/web";
import { buildMarketplaceMeta } from "../seo";

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Sign In | Marketplace" });

export default function MarketplaceSignInRoute() {
  return <SignInPage />;
}
