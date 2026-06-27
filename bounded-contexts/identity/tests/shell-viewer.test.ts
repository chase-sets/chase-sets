import { describe, expect, it } from "vitest";
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
    let readCount = 0;
    const api = {
      async getUserPreferences<T>() {
        readCount += 1;

        return {
          userId: actor.userId,
          colorMode: "dark",
          density: "compact",
          reducedMotion: "user",
          locale: "en-US",
          timeZone: "America/Chicago",
        } as T;
      },
    } satisfies IdentityShellViewerPreferencesApi;

    await expect(resolveIdentityShellViewer(api, actor)).resolves.toEqual({
      actor,
      preferences: {
        colorMode: "dark",
        reducedMotion: "user",
      },
    });
    expect(readCount).toBe(1);
  });

  it("returns no preferences for unauthenticated shell viewers", async () => {
    let readCount = 0;
    const api = {
      async getUserPreferences<T>() {
        readCount += 1;
        throw new Error("Preferences should not be read without an actor.");
      },
    } satisfies IdentityShellViewerPreferencesApi;

    await expect(resolveIdentityShellViewer(api, null)).resolves.toEqual({
      actor: null,
      preferences: null,
    });
    expect(readCount).toBe(0);
  });
});
