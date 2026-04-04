import type { ActionFunctionArgs } from "react-router";
import { signOutActorViaAuthApi } from "../../server";

export async function action({ request }: ActionFunctionArgs) {
  return signOutActorViaAuthApi(request, { returnTo: "/search" });
}

export default function MarketplaceSignOutRoute() {
  return null;
}
