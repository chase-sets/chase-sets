import type { ActionFunctionArgs } from "react-router";
import { signOutMarketplaceActor } from "../auth.server";

export async function action({ request }: ActionFunctionArgs) {
  return signOutMarketplaceActor(request);
}

export default function MarketplaceSignOutRoute() {
  return null;
}
