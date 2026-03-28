import type { MetaFunction } from "react-router";
import { RegisterPage } from "@chase-sets/identity/web";
import { buildMarketplaceMeta } from "../seo";

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Register | Marketplace" });

export default function MarketplaceRegisterRoute() {
  return <RegisterPage />;
}
