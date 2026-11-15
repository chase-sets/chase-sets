import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { readUserPreferencesColorModeCookie } from "../../features/preferences/api/color-mode-cookie";
import type { UserPreferences } from "../../features/preferences/api/contracts";
import { createIdentityApiClient } from "../request-support/api-client";
import type { CurrentActorDisplay } from "./current-actor-display";
import { resolveIdentityShellViewer, type IdentityShellViewer } from "./viewer";

type MarketplaceRootTheme = Readonly<{
  colorMode: UserPreferences["colorMode"];
  cookieSeedColorMode: UserPreferences["colorMode"] | null;
  viewer: IdentityShellViewer | null;
}>;

function createMarketplaceRootIdentityApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "identity" }),
  });
}

export async function resolveCurrentActorDisplay(request: Request, actor: ResolvedActor | null) {
  if (!actor || actor.roleKey === "guest-buyer") {
    return null;
  }

  try {
    const identityApi = createMarketplaceRootIdentityApiClient(request);
    return await identityApi.getCurrentActorDisplay<CurrentActorDisplay>();
  } catch {
    return null;
  }
}

export async function resolveMarketplaceRootTheme(
  request: Request,
  actor: ResolvedActor | null,
): Promise<MarketplaceRootTheme> {
  if (!actor || actor.roleKey === "guest-buyer") {
    return { colorMode: "system", cookieSeedColorMode: null, viewer: null };
  }

  const cookieColorMode = readUserPreferencesColorModeCookie(request);

  try {
    const viewer = await resolveIdentityShellViewer(createMarketplaceRootIdentityApiClient(request), actor);
    const colorMode = viewer.preferences?.colorMode ?? cookieColorMode ?? "system";

    return {
      colorMode,
      cookieSeedColorMode: viewer.preferences?.colorMode ?? null,
      viewer,
    };
  } catch {
    return {
      colorMode: cookieColorMode ?? "system",
      cookieSeedColorMode: null,
      viewer: cookieColorMode
        ? {
            actor,
            preferences: { colorMode: cookieColorMode, reducedMotion: "user" },
          }
        : null,
    };
  }
}
