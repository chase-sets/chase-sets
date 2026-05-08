import { describe, expect, it } from "vitest";
import type { ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import { buildAdminSupportApiApp } from "../src/app";

function createEmptyRuntime(): ApiHostRuntime {
  return {
    mountedContexts: [],
    mountedModules: [],
    services: {},
    projectors: [],
    projectionGroups: [],
    subscriptionRunners: [],
  };
}

describe("admin-support API app", () => {
  it("blocks admin self-registration unless explicitly enabled", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      adminRegistrationEnabled: false,
    });

    const response = await app.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
  });
});
