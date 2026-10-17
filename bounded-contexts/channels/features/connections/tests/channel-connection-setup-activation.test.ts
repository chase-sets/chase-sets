import { describe, expect, it, vi } from "vitest";
import type { ChannelConnectionSetupDeclaration } from "../domain/contracts";
import { activateFixture, connectFixture, createConnectionHarness, testContext } from "./test-support";

describe("channel-connection-setup-activation", () => {
  it("fails closed when a declaration is removed before activation without authority fallthrough or a write", async () => {
    const { services, setups, authorityCalls, memory } = createConnectionHarness();
    await connectFixture(services);
    const before = memory.streams.get("channels.connection-connection_1")?.length;
    setups.clear();
    await expect(activateFixture(services)).rejects.toMatchObject({
      code: "provider-setup-not-registered",
    });
    expect(authorityCalls).toMatchObject({ credential: 0, policy: 0, storage: 0 });
    expect(memory.streams.get("channels.connection-connection_1")?.length).toBe(before);
  });

  it("applies credential precedence for required and not-required declarations", async () => {
    const credentialResolve = vi.fn();
    const required = createConnectionHarness({ credentialAuthority: { resolve: credentialResolve } });
    await connectFixture(required.services);
    await expect(
      required.services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection_1",
          bindings: [{ storageLocationId: "location_1", revision: 1 }],
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "credential-not-current" });
    expect(credentialResolve).not.toHaveBeenCalled();

    const notRequiredDeclaration: ChannelConnectionSetupDeclaration = {
      providerKey: "fixture-provider",
      environment: "sandbox",
      requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
    };
    const optional = createConnectionHarness({
      setupResolver: { resolve: async () => notRequiredDeclaration },
      credentialAuthority: { resolve: async () => null },
    });
    await connectFixture(optional.services);
    await expect(
      optional.services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection_1",
          bindings: [{ storageLocationId: "location_1", revision: 1 }],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ state: { status: "active", credentialReference: null } });

    const supplied = createConnectionHarness({
      setupResolver: { resolve: async () => notRequiredDeclaration },
      credentialAuthority: { resolve: async () => null },
    });
    await connectFixture(supplied.services);
    await expect(activateFixture(supplied.services)).rejects.toMatchObject({ code: "credential-not-current" });
  });

  it("rejects 201 or duplicate bindings before any authority I/O and preserves caller order at 200", async () => {
    for (const bindings of [
      Array.from({ length: 201 }, (_, revision) => ({ storageLocationId: `location_${revision}`, revision })),
      [
        { storageLocationId: "location_1", revision: 1 },
        { storageLocationId: "location_1", revision: 2 },
      ],
    ]) {
      const { services, authorityCalls, memory } = createConnectionHarness();
      await connectFixture(services);
      await expect(
        services.activateChannelConnection(
          {
            accountId: "acc_owner",
            connectionId: "connection_1",
            credentialReference: "credential-reference-1",
            bindings,
          },
          testContext,
        ),
      ).rejects.toMatchObject({ code: "invalid-input" });
      expect(authorityCalls).toMatchObject({ credential: 0, policy: 0, storage: 0 });
      expect(memory.streams.get("channels.connection-connection_1")).toHaveLength(1);
    }

    const { services } = createConnectionHarness();
    await connectFixture(services);
    const bindings = Array.from({ length: 200 }, (_, revision) => ({
      storageLocationId: `location_${revision}`,
      revision,
    }));
    const activated = await services.activateChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1", credentialReference: "credential-reference-1", bindings },
      testContext,
    );
    expect(activated.newEvents[0]).toMatchObject({ data: { bindings } });
    expect(activated.state.bindings).toEqual(bindings);
    const paused = await services.pauseChannelConnection(
      { accountId: "acc_owner", connectionId: "connection_1" },
      testContext,
    );
    expect(paused.state.bindings).toEqual(bindings);
  });

  it("returns binding-required only after credential and policy guards", async () => {
    const { services, authorityCalls } = createConnectionHarness();
    await connectFixture(services);
    await expect(
      services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection_1",
          credentialReference: "credential-reference-1",
          bindings: [],
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "binding-required" });
    expect(authorityCalls).toMatchObject({ credential: 1, policy: 1, storage: 0 });
  });

  it("fails resume before authority fallthrough when its persisted declaration is removed", async () => {
    const { services, setups, authorityCalls, memory } = createConnectionHarness();
    await connectFixture(services);
    await activateFixture(services);
    await services.pauseChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext);
    setups.clear();
    const callsBefore = { ...authorityCalls };
    const eventCount = memory.streams.get("channels.connection-connection_1")?.length;
    await expect(
      services.resumeChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext),
    ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
    expect(authorityCalls).toEqual(callsBefore);
    expect(memory.streams.get("channels.connection-connection_1")?.length).toBe(eventCount);
  });

  it("rejects secret-shaped credential references without persisting or logging them", async () => {
    const { services, memory, authorityCalls } = createConnectionHarness();
    await connectFixture(services);
    await expect(
      services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection_1",
          credentialReference: "access-token-sensitive-value",
          bindings: [{ storageLocationId: "location_1", revision: 1 }],
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(authorityCalls.credential).toBe(0);
    expect(JSON.stringify(memory.readAllEvents())).not.toContain("access-token-sensitive-value");
  });
});
