import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { resolveIdentityShellViewer, type IdentityShellViewerPreferencesApi } from "../support/shell-support/viewer";

const actor = {
  sessionId: "session_admin",
  tenantId: "tenant_chase_sets",
  userId: "usr_admin",
  accountId: "account_platform",
  membershipId: "membership_admin",
  roleKey: "platform-admin",
  permissions: ["catalog.view"],
} satisfies ResolvedActor;

describe("identity shell viewer", () => {
  it("folds signed-in resolved preferences into the shell viewer read model", async () => {
    const api = {
      getUserPreferences: vi.fn(
        async <T>() =>
          ({
            userId: actor.userId,
            colorMode: "dark",
            density: "compact",
            reducedMotion: "user",
            locale: "en-US",
            timeZone: "America/Chicago",
          }) as T,
      ),
    } satisfies IdentityShellViewerPreferencesApi;

    await expect(resolveIdentityShellViewer(api, actor)).resolves.toEqual({
      actor,
      preferences: {
        colorMode: "dark",
      },
    });
    expect(api.getUserPreferences).toHaveBeenCalledOnce();
  });

  it("returns no preferences for unauthenticated shell viewers", async () => {
    const api = {
      getUserPreferences: vi.fn(async <T>() => {
        throw new Error("Preferences should not be read without an actor.");
      }),
    } satisfies IdentityShellViewerPreferencesApi;

    await expect(resolveIdentityShellViewer(api, null)).resolves.toEqual({
      actor: null,
      preferences: null,
    });
    expect(api.getUserPreferences).not.toHaveBeenCalled();
  });
});
