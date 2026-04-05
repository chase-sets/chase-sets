import type { ActionFunctionArgs } from "react-router";
import { signOutActorViaAuthApi } from "../../route-support/browser-auth";

export async function action({ request }: ActionFunctionArgs) {
  return signOutActorViaAuthApi(request, { returnTo: "/sign-in" });
}

export default function CatalogAdminSignOutRoute() {
  return null;
}
