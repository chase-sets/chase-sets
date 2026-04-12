import { identityAdminAuthHost } from "../../route-support/auth-host.server";

export const action = identityAdminAuthHost.createSignOutAction();

export default function IdentityAdminSignOutRoute() {
  return null;
}
