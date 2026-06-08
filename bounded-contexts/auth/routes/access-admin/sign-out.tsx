import { accessAdminAuthHost } from "../../support/route-support/auth-host.server";

export const action = accessAdminAuthHost.createSignOutAction();

export default function AccessAdminSignOutRoute() {
  return null;
}
