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
  it("serves readiness under the same-origin API prefix", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      readinessChecks: [
        {
          name: "test",
          check: async () => undefined,
        },
      ],
    });

    const response = await app.request("/api/health/ready");

    expect(response.status).toBe(200);
  });

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

  it("requires platform operations permission for projection operations", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "catalog-admin",
        permissions: ["catalog.view"],
      }),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(403);
  });

  it("returns projection operations status for platform operators", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "platform-admin",
        permissions: ["security.manage"],
      }),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        status: "ok",
        totalGroups: 0,
      },
      projectionGroups: [],
      blockedProjections: [],
      projectionStatusSource: "runtime-memory",
      workers: [],
      runners: [],
    });
  });
});
