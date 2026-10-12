import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { module as identityModule } from "@chase-sets/identity";
import {
  parseCapabilityAdministrationAuthority,
  DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
  type IdentityServices,
} from "@chase-sets/identity/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { resolveApiHostMounts } from "@chase-sets/platform-runtime/api";

const stores = vi.hoisted(() => ({
  constructingIdentity: false,
  identity: undefined as ReturnType<typeof createInMemoryEventStore>["eventStore"] | undefined,
}));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  return {
    ...actual,
    createPostgresEventStore: (options: Parameters<typeof actual.createPostgresEventStore>[0]) => {
      if (stores.constructingIdentity) return (stores.identity = createInMemoryEventStore().eventStore);
      return actual.createPostgresEventStore(options);
    },
  };
});

describe("Capability Administration Authority actual platform-api host port", () => {
  const tuple = '["support-deployment-instance/v1","preview-9385","release-a"]';
  const declaration = {
    version: 1,
    environment: "preview",
    deploymentInstance: tuple,
    authorityId: "support-admin",
    revision: 1,
    adminUserIds: ["usr_synthetic"],
  };
  const scope = { environment: "preview", deploymentInstance: tuple, implementationSha: "a".repeat(40) };
  it.each([
    JSON.stringify(declaration),
    undefined,
    "PLANTED_SECRET",
    JSON.stringify({
      ...declaration,
      deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-b"]',
    }),
  ])("passes the validated authority through actual createPlatformApiHost: %s", async (raw) => {
    const pools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/synthetic",
      contextDatabaseUrls: {},
      port: 6182,
    });
    const original = identityModule.createServices;
    const create = vi.spyOn(identityModule, "createServices").mockImplementation((...args) => {
      stores.constructingIdentity = true;
      try {
        return original(...args);
      } finally {
        stores.constructingIdentity = false;
      }
    });
    try {
      const authority = parseCapabilityAdministrationAuthority(raw, scope);
      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: authority,
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });
      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          capabilityAdministrationAuthority: authority,
          accountCapabilityRegistry: expect.arrayContaining([
            expect.objectContaining({ key: "support.evidence.any-case", defaultValue: false }),
          ]),
        }),
        expect.anything(),
      );
      const services = runtime.services.identity as IdentityServices;
      await services.accountCapabilities.initializeAdministrationAuthority();
      const actor = {
        sessionId: "ses_synthetic",
        membershipId: "mbr_synthetic",
        userId: "usr_synthetic",
        accountId: "acc_actor",
        tenantId: "tnt_synthetic",
        roleKey: "member",
        permissions: [],
        authenticatedAt: new Date().toISOString(),
      };
      const context = {
        tenantId: actor.tenantId as never,
        audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
      };
      await stores.identity!.appendToStream({
        streamId: "identity.account-acc_target",
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "identity.account.created", payload: {} }],
      });
      const mounted = resolveApiHostMounts(runtime).find((entry) => entry.mountPath === "/api/identity")!;
      if (!(mounted.router instanceof Hono)) throw new Error("Identity router was not mounted by the real host.");
      const app = new Hono<{ Variables: { actor: ResolvedActor; context: EventStoreContext } }>();
      app.use("*", async (c, next) => {
        c.set("actor", actor);
        c.set("context", context);
        await next();
      });
      app.route(mounted.mountPath, mounted.router);
      const response = await app.request("/api/identity/account-capabilities/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "acc_target",
          capabilityKey: "support.evidence.any-case",
          expectedVersion: 0,
        }),
      });
      expect(response.status).toBe(authority.kind === "configured" ? 200 : 403);
      expect(
        (await stores.identity!.readAll()).filter((event) => event.streamId.startsWith("identity.account-capability-")),
      ).toHaveLength(authority.kind === "configured" ? 1 : 0);
    } finally {
      create.mockRestore();
      await closePlatformApiPools(pools);
    }
  });
  it("omitted authority fails real host boot; main supplies Identity's imported typed port and awaits its receipt", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/synthetic",
      contextDatabaseUrls: {},
      port: 6182,
    });
    try {
      expect(() => createPlatformApiHost({ runtimeProfile: "landing", pools, hostPorts: {} })).toThrow(
        /capabilityAdministrationAuthority host capability/,
      );
    } finally {
      await closePlatformApiPools(pools);
    }
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain('Pick<IdentityHostPorts, "capabilityAdministrationAuthority">');
    expect(main).toContain("...capabilityAdministrationPorts");
    expect(main).toContain(
      "await (runtime.services.identity as IdentityServices).accountCapabilities.initializeAdministrationAuthority()",
    );
  });
  it("direct services require the port, and explicit deny-all creates no authority receipt", async () => {
    const pool = {
      query: () => {
        throw new Error("No DB access allowed");
      },
    } as never;
    expect(() => identityModule.createServices(pool, undefined!)).toThrow(/capabilityAdministrationAuthority/);
    const services = identityModule.createServices(pool, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    await expect(services.accountCapabilities.initializeAdministrationAuthority()).resolves.toBeNull();
  });
  it.each(["bootstrap.ts", "representative-commerce-state.ts", "admin-qa-actor-fixtures.ts"])(
    "%s explicitly denies administration instead of inheriting deployment activation",
    (file) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).toContain(
        'capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" }',
      );
    },
  );
});
