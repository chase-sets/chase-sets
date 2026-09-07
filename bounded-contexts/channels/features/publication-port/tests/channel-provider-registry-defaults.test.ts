import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { module as channelsModule } from "../../../index";
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import type { ChannelConnectionHostPorts } from "../../connections/domain/contracts";
import { channelProviderRegistry, createChannelProviderRegistry } from "../api/registry";
import type { ChannelProviderDescriptor, ChannelPublicationCapability } from "../domain/contracts";
import {
  createFixtureSetup,
  createInlineDescriptor,
  createPublishInput,
  fixtureClaimedIdentity,
  fixtureInlineIdentity,
} from "./test-support";

const context: EventStoreContext = {
  tenantId: "fixture-tenant" as never,
  audit: { performedByUserId: "fixture-user" as never, forAccountId: "fixture-account" as never },
};

describe("channel-provider-registry-defaults", () => {
  it("keeps the one production registry empty across both environments and repeated module composition", async () => {
    expect(channelProviderRegistry.list()).toEqual([]);
    for (const environment of ["sandbox", "production"] as const) {
      const identity = { providerKey: "fixture-unregistered-provider", environment };
      expect(channelProviderRegistry.get(identity)).toBeNull();
      await expect(channelProviderRegistry.setupResolver.resolve(identity)).resolves.toBeNull();
    }

    const pool = createEmptyPool();
    const first = channelsModule.createServices(pool, {});
    const second = channelsModule.createServices(pool, {});
    for (const services of [first, second]) {
      await expect(
        services.connections.connectChannel(
          {
            connectionId: "fixture-production-connection",
            accountId: "fixture-account",
            providerKey: "fixture-unregistered-provider",
          },
          { deploymentEnvironment: "production" },
          context,
        ),
      ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
    }
    expect(channelProviderRegistry.list()).toEqual([]);
  });

  it("activates only construction-time fixture identities without changing production", () => {
    let providerCalls = 0;
    const inline = createInlineDescriptor(createCountingCapability(() => providerCalls++));
    const claimed: ChannelProviderDescriptor = {
      identity: fixtureClaimedIdentity,
      setup: createFixtureSetup(fixtureClaimedIdentity),
      publication: { execution: "claimed" },
    };
    const registry = createChannelProviderRegistry([inline, claimed]);

    expect(registry.list()).toEqual([fixtureClaimedIdentity, fixtureInlineIdentity]);
    expect(registry.get(fixtureInlineIdentity)?.publication).toMatchObject({ execution: "inline" });
    expect(registry.get(fixtureClaimedIdentity)?.publication).toEqual({ execution: "claimed" });
    expect(registry.get({ ...fixtureInlineIdentity, environment: "production" })).toBeNull();
    expect(providerCalls).toBe(0);
    expect(channelProviderRegistry.list()).toEqual([]);
  });

  it("keeps all four producer states distinct and makes zero provider calls in the first three", () => {
    let providerCalls = 0;
    const absentIdentity = { providerKey: "fixture-absent-provider", environment: "sandbox" } as const;
    const inline = createInlineDescriptor(createCountingCapability(() => providerCalls++));
    const registry = createChannelProviderRegistry([
      { identity: absentIdentity, setup: createFixtureSetup(absentIdentity) },
      {
        identity: fixtureClaimedIdentity,
        setup: createFixtureSetup(fixtureClaimedIdentity),
        publication: { execution: "claimed" },
      },
      inline,
    ]);

    const states = [
      { identity: { providerKey: "fixture-missing-provider", environment: "sandbox" } as const, expected: null },
      { identity: absentIdentity, expected: null },
      { identity: fixtureClaimedIdentity, expected: "claimed" },
      { identity: fixtureInlineIdentity, expected: "inline" },
    ];
    for (const [index, state] of states.entries()) {
      const resolved = registry.get(state.identity);
      if (index === 0) expect(resolved).toBeNull();
      else expect(resolved?.publication?.execution ?? null).toBe(state.expected);
      if (index < 3) expect(providerCalls).toBe(0);
    }
    expect(Object.hasOwn(registry.get(absentIdentity)!, "publication")).toBe(true);
    expect(registry.get(absentIdentity)?.publication).toBeNull();
  });

  it("rejects duplicate, identity-divergent, open descriptor, and open capability registrations", () => {
    const descriptor = createInlineDescriptor(createCountingCapability(() => undefined));
    expectInvalid(() => createChannelProviderRegistry([descriptor, descriptor]), "duplicates");
    expectInvalid(
      () =>
        createChannelProviderRegistry([
          {
            ...descriptor,
            setup: { ...descriptor.setup, environment: "production" },
          },
        ]),
      "identity",
    );
    expectInvalid(
      () =>
        createChannelProviderRegistry([
          {
            ...descriptor,
            // @ts-expect-error descriptor records are closed
            fixtureExtra: true,
          },
        ]),
      "unknown field",
    );
    expectInvalid(
      () =>
        createChannelProviderRegistry([
          {
            identity: fixtureClaimedIdentity,
            setup: createFixtureSetup(fixtureClaimedIdentity),
            publication: {
              execution: "claimed",
              // @ts-expect-error claimed records cannot carry inline members
              publishListing: async () => ({ kind: "rejected", code: "validation" }),
            },
          },
        ]),
      "unknown field",
    );
  });

  it("does not inspect or invoke adapters during construction and propagates their thrown identity unchanged", async () => {
    let calls = 0;
    const failure = new Error("fixture adapter failure");
    async function throwsUnchanged() {
      calls += 1;
      throw failure;
    }
    const registry = createChannelProviderRegistry([
      createInlineDescriptor({
        execution: "inline",
        publishListing: throwsUnchanged,
        updatePriceQuantity: throwsUnchanged,
        delistListing: throwsUnchanged,
      }),
    ]);
    expect(calls).toBe(0);
    const publication = registry.get(fixtureInlineIdentity)?.publication;
    expect(publication?.execution).toBe("inline");
    if (!publication || publication.execution !== "inline") throw new Error("Expected fixture inline capability.");
    await expect(publication.publishListing(createPublishInput())).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("snapshots and freezes identity, setup, ordering, and resolved publication state", () => {
    const requiredPolicyKeys: string[] = ["fixture-policy"];
    const descriptor = {
      identity: { ...fixtureInlineIdentity },
      setup: {
        ...createFixtureSetup(fixtureInlineIdentity),
        requirements: {
          credential: "not-required" as const,
          requiredPolicyKeys,
          binding: "one-or-more-current" as const,
        },
      },
      publication: createCountingCapability(() => undefined),
    } satisfies ChannelProviderDescriptor;
    const registry = createChannelProviderRegistry([descriptor]);
    requiredPolicyKeys.push("fixture-late-policy");
    descriptor.identity.providerKey = "fixture-mutated-provider";

    const resolved = registry.get(fixtureInlineIdentity);
    expect(resolved?.identity).toEqual(fixtureInlineIdentity);
    expect(resolved?.setup.requirements.requiredPolicyKeys).toEqual(["fixture-policy"]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(channelProviderRegistry.list()).toEqual([]);
  });

  it("keeps connect, activate, and resume on the actual production-empty setup resolver", async () => {
    const memory = createInMemoryEventStore();
    const db = { query: async () => ({ rows: [] }) };
    const fixtureRegistry = createChannelProviderRegistry([
      { identity: fixtureInlineIdentity, setup: createFixtureSetup(fixtureInlineIdentity) },
    ]);
    const authorityPorts: ChannelConnectionHostPorts = {
      setupResolver: fixtureRegistry.setupResolver,
      storageLocationAuthority: {
        resolve: async ({ accountId, storageLocationId }) => ({
          accountId,
          storageLocationId,
          revision: 1,
          status: "active",
        }),
      },
      clock: { now: () => "2026-09-07T03:00:00Z" },
    };
    const fixtureServices = createChannelConnectionRuntime({ eventStore: memory.eventStore, db }, authorityPorts);
    await connect(fixtureServices, "fixture-pending-connection");
    await connect(fixtureServices, "fixture-paused-connection");
    await fixtureServices.activateChannelConnection(
      {
        accountId: "fixture-account",
        connectionId: "fixture-paused-connection",
        bindings: [{ storageLocationId: "fixture-location", revision: 1 }],
      },
      context,
    );
    await fixtureServices.pauseChannelConnection(
      { accountId: "fixture-account", connectionId: "fixture-paused-connection" },
      context,
    );

    const productionServices = createChannelConnectionRuntime(
      { eventStore: memory.eventStore, db },
      { ...authorityPorts, setupResolver: channelProviderRegistry.setupResolver },
    );
    await expect(
      productionServices.activateChannelConnection(
        {
          accountId: "fixture-account",
          connectionId: "fixture-pending-connection",
          bindings: [{ storageLocationId: "fixture-location", revision: 1 }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
    await expect(
      productionServices.resumeChannelConnection(
        { accountId: "fixture-account", connectionId: "fixture-paused-connection" },
        context,
      ),
    ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
  });
});

function createCountingCapability(onCall: () => void): Extract<ChannelPublicationCapability, { execution: "inline" }> {
  return {
    execution: "inline",
    publishListing: async () => {
      onCall();
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    },
    updatePriceQuantity: async () => {
      onCall();
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    },
    delistListing: async () => {
      onCall();
      return { kind: "succeeded", externalListingId: "fixture-external-listing" };
    },
  };
}

function expectInvalid(action: () => unknown, message: string): void {
  expect(action).toThrow(expect.objectContaining({ code: "invalid-input", message: expect.stringContaining(message) }));
}

function createEmptyPool(): PgTransactionalPool {
  const query: PgQueryFunction = async () => ({ rows: [] });
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
}

async function connect(
  services: ReturnType<typeof createChannelConnectionRuntime>,
  connectionId: string,
): Promise<void> {
  await services.connectChannel(
    { connectionId, accountId: "fixture-account", providerKey: fixtureInlineIdentity.providerKey },
    { deploymentEnvironment: "local" },
    context,
  );
}
