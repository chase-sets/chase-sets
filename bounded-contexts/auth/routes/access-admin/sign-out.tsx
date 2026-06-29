import { adminAuthHost } from "../../support/route-support/auth-host.server";

export const action = adminAuthHost.createSignOutAction();

export default function AccessAdminSignOutRoute() {
  return null;
}
