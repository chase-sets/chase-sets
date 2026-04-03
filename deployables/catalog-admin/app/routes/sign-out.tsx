import type { ActionFunctionArgs } from "react-router";
import { signOutCatalogAdmin } from "../auth.server";

export async function action({ request }: ActionFunctionArgs) {
  return signOutCatalogAdmin(request);
}

export default function CatalogAdminSignOutRoute() {
  return null;
}
