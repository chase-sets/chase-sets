import { describe, expect, it, vi } from "vitest";
import type { CatalogOperatorAuthority } from "@chase-sets/catalog/server";
import { module as identityModule } from "@chase-sets/identity";
import type { IdentityServices } from "@chase-sets/identity/server";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createMembershipRuntime, type MembershipCommand } from "@chase-sets/identity/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

const captured = vi.hoisted(() => ({
  ports: undefined as Readonly<Record<string, unknown>> | undefined,
}));
const stores = vi.hoisted(() => ({
  constructingIdentity: false,
  identity: undefined as ReturnType<typeof createInMemoryEventStore>["eventStore"] | undefined,
}));

vi.mock("@chase-sets/platform-runtime/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/platform-runtime/api")>();
  return {
    ...actual,
    createApiHost: (...args: Parameters<typeof actual.createApiHost>) => {
      captured.ports = args[2].hostPorts;
      return actual.createApiHost(...args);
    },
  };
});

vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  const fakePool = () => {
    const client = {
      query: async () => ({ rows: [] }),
      release: () => undefined,
    };
    return { query: client.query, connect: async () => client, end: async () => undefined };
  };
  return {
    ...actual,
    createPgPool: fakePool,
    createPostgresEventStore: (_options: Parameters<typeof actual.createPostgresEventStore>[0]) => {
      const store = createInMemoryEventStore().eventStore;
      if (stores.constructingIdentity) stores.identity = store;
      return store;
    },
    createPostgresProjectionStore: () =>
      actual.createPostgresProjectionStore({ db: { query: async () => ({ rows: [] }) } as never }),
  };
});

describe("platform-api Catalog operator authority composition", () => {
  it("passes the real Identity authority and evaluates the live Membership aggregate", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/synthetic",
      contextDatabaseUrls: {},
      port: 6182,
    });
    const originalIdentityCreateServices = identityModule.createServices;
    const identitySpy = vi.spyOn(identityModule, "createServices").mockImplementation((...args) => {
      stores.constructingIdentity = true;
      try {
        return originalIdentityCreateServices(...args);
      } finally {
        stores.constructingIdentity = false;
      }
    });
    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });
      const catalogAuthority = captured.ports?.catalogOperatorAuthority as CatalogOperatorAuthority | undefined;
      expect(catalogAuthority).toBeDefined();
      expect(catalogAuthority?.forActor).toBe(captured.ports?.operatorAuthority);
      expect(typeof catalogAuthority?.forGrantCreator).toBe("function");

      const identity = runtime.services.identity as IdentityServices;
      expect(stores.identity).toBeDefined();
      const memory = createInMemoryEventStore();
      const db = { query: async () => ({ rows: [] }) };
      const memberships = createMembershipRuntime({
        eventStore: memory.eventStore,
        checkpointStore: createPostgresProjectionStore({ db }),
        db,
      });
      const getMembershipStateSpy = vi
        .spyOn(identity.memberships, "getMembershipState")
        .mockImplementation(memberships.getMembershipState);
      const context = {
        tenantId: "tnt_synthetic",
        audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
      } as EventStoreContext;
      const run = (membershipId: string, command: MembershipCommand) =>
        memberships.commandHandler({ streamId: `identity.membership-${membershipId}`, command, context });
      await run("mbr_creator", {
        type: "GrantMembership",
        membershipId: "mbr_creator" as never,
        userId: "usr_creator" as never,
        accountId: "acc_creator" as never,
        roleKey: "platform-admin",
        assignmentAuthority: { type: "platform-bootstrap" },
      });
      await expect(
        catalogAuthority!.forGrantCreator({ userId: "usr_creator", membershipId: "mbr_creator" }),
      ).resolves.toMatchObject({
        kind: "granted",
        membershipId: "mbr_creator",
      });

      await run("mbr_creator", {
        type: "ChangeMembershipRole",
        roleKey: "owner",
        assignmentAuthority: { type: "system" },
      });
      await expect(
        catalogAuthority!.forGrantCreator({ userId: "usr_creator", membershipId: "mbr_creator" }),
      ).resolves.toEqual({
        kind: "denied",
        reason: "not-platform-admin",
      });
      getMembershipStateSpy.mockRestore();
    } finally {
      identitySpy.mockRestore();
      await closePlatformApiPools(pools);
    }
  });
});
