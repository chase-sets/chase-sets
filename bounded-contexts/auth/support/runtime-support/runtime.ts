import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readAuthSessionToken } from "../auth-support/http";
import type { AuthServices } from "./services";
import { createAuthBootstrapContext as createAuthBootstrapEventContext } from "../auth-support/identity-projection";
import { getSessionByTokenHash } from "../auth-support/store";
import { resolveActorFromSessionId } from "./services";
export { readAuthSessionToken } from "../auth-support/http";

export function createAuthBootstrapContext(
  _services: AuthServices,
): EventStoreContext {
  return createAuthBootstrapEventContext();
}

export async function resolveActorFromSessionToken(
  services: AuthServices,
  sessionToken: string,
): Promise<ResolvedActor | null> {
  const tokenRecord = await getSessionByTokenHash(
    services.db,
    services.auth.hashSecret(sessionToken),
  );

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return resolveActorFromSessionId(services, tokenRecord.session_id);
}

export async function resolveActorFromRequest(
  services: AuthServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const sessionToken = readAuthSessionToken(request);
  if (!sessionToken) {
    return null;
  }

  return resolveActorFromSessionToken(services, sessionToken);
}
