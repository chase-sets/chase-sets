import type { ResolvedActor } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";

export function requireProviderConnectionsActor(actor: ResolvedActor | null | undefined) {
  if (!actor) throw new Response(t("platformOperations.providerConnections.authenticationRequired"), { status: 401 });
  if (actor.roleKey !== "platform-admin" || !actor.permissions.includes("provider-connections.view")) {
    throw new Response(t("platformOperations.providerConnections.forbidden"), { status: 403 });
  }
}
