import type { ActionFunctionArgs } from "react-router";
import { signOutActorViaAuthApi } from "../../server";

export async function action({ request }: ActionFunctionArgs) {
  return signOutActorViaAuthApi(request, { returnTo: "/sign-in" });
}

export default function CatalogAdminSignOutRoute() {
  return null;
}
