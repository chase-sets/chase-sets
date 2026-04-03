import type { ActionFunctionArgs } from "react-router";
import { signOutIdentityAdmin } from "../auth.server";

export async function action({ request }: ActionFunctionArgs) {
  return signOutIdentityAdmin(request);
}

export default function IdentityAdminSignOutRoute() {
  return null;
}
