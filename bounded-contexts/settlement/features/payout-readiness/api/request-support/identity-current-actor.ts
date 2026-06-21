import { createIdentityRequestApiClient, type CurrentActorDisplay } from "@chase-sets/identity/server";

export async function resolveCurrentActorPrimaryEmail(request: Request) {
  try {
    const actorDisplay = await createIdentityRequestApiClient(request).getCurrentActorDisplay<CurrentActorDisplay>();
    return actorDisplay.user.primary_email?.trim() || null;
  } catch {
    return null;
  }
}
