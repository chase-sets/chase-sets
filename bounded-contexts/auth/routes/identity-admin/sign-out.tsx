import type { ActionFunctionArgs } from "react-router";
import { signOutActorViaAuthApi } from "../../browser-auth";

export async function action({ request }: ActionFunctionArgs) {
  return signOutActorViaAuthApi(request, { returnTo: "/sign-in" });
}

export default function IdentityAdminSignOutRoute() {
  return null;
}
