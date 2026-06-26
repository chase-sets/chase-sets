import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { UserPreferences } from "../../features/preferences/domain/domain";

export type IdentityShellViewerPreferences = Pick<UserPreferences, "colorMode">;

export type IdentityShellViewer = Readonly<{
  actor: ResolvedActor | null;
  preferences: IdentityShellViewerPreferences | null;
}>;

export type IdentityShellViewerPreferencesApi = Readonly<{
  getUserPreferences<T>(): Promise<T>;
}>;

export async function resolveIdentityShellViewer(
  api: IdentityShellViewerPreferencesApi,
  actor: ResolvedActor | null | undefined,
): Promise<IdentityShellViewer> {
  if (!actor) {
    return { actor: null, preferences: null };
  }

  const preferences = await api.getUserPreferences<UserPreferences>();

  return {
    actor,
    preferences: {
      colorMode: preferences.colorMode,
    },
  };
}
