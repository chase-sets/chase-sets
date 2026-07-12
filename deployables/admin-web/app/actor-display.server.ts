import {
  createIdentityRequestApiClient,
  requestWithoutFreshWrite,
  type CurrentActorDisplay,
} from "@chase-sets/identity/server";

/**
 * Resolves the human-readable account/user/membership facts for the signed-in
 * admin actor so the shell can render real display names instead of raw ids.
 * Best-effort: chrome that fails to resolve falls back to placeholder labels
 * rather than blocking the page.
 */
export async function resolveAdminActorDisplay(request: Request): Promise<CurrentActorDisplay | null> {
  try {
    const api = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
    return await api.getCurrentActorDisplay<CurrentActorDisplay>();
  } catch {
    return null;
  }
}
