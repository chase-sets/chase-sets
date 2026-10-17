import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import type { ChannelConnectionSetupResolver } from "../../connections/domain/contracts";
import { createChannelProviderRegistry } from "../api/registry";
import type { ChannelProviderIdentity, ChannelProviderRegistry } from "../domain/contracts";
import { createFixtureSetup, fixtureInlineIdentity } from "./test-support";

describe("channel-provider-identity-parity", () => {
  it("uses the exact provider/environment coordinate for lookup and setup resolution", async () => {
    const registry = createChannelProviderRegistry([
      { identity: fixtureInlineIdentity, setup: createFixtureSetup(fixtureInlineIdentity) },
    ]);
    expect(registry.get(fixtureInlineIdentity)?.identity).toEqual(fixtureInlineIdentity);
    expect(registry.get({ ...fixtureInlineIdentity, environment: "production" })).toBeNull();
    await expect(registry.setupResolver.resolve(fixtureInlineIdentity)).resolves.toEqual(
      createFixtureSetup(fixtureInlineIdentity),
    );
    await expect(
      registry.setupResolver.resolve({ ...fixtureInlineIdentity, environment: "production" }),
    ).resolves.toBeNull();
    expectTypeOf<Parameters<ChannelProviderRegistry["get"]>[0]>().toEqualTypeOf<ChannelProviderIdentity>();
    expectTypeOf<Parameters<ChannelConnectionSetupResolver["resolve"]>[0]>().toEqualTypeOf<ChannelProviderIdentity>();
  });

  it("retains the connection runtime's resolve-time identity parity check", async () => {
    let calls = 0;
    const runtime = createChannelConnectionRuntime(
      {
        eventStore: createInMemoryEventStore().eventStore,
        db: { query: async () => ({ rows: [] }) },
      },
      {
        setupResolver: {
          resolve: async () => {
            calls += 1;
            return { ...createFixtureSetup(fixtureInlineIdentity), environment: "production" };
          },
        },
      },
    );
    await expect(
      runtime.connectChannel(
        {
          connectionId: "fixture-identity-parity-connection",
          accountId: "fixture-account",
          providerKey: fixtureInlineIdentity.providerKey,
        },
        { deploymentEnvironment: "local" },
        {
          tenantId: "fixture-tenant" as never,
          audit: { performedByUserId: "fixture-user" as never, forAccountId: "fixture-account" as never },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("identity") });
    expect(calls).toBe(1);
  });

  it("rejects open or invalid runtime lookup identities", () => {
    const registry = createChannelProviderRegistry([]);
    expect(() =>
      registry.get({
        ...fixtureInlineIdentity,
        // @ts-expect-error lookup identities are closed
        accountId: "fixture-account",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      registry.get({
        providerKey: fixtureInlineIdentity.providerKey,
        // @ts-expect-error deployment environments do not belong to this identity
        environment: "staging",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
  });
});
