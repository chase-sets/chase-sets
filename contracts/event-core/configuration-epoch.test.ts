import { describe, expect, it } from "vitest";
import { createInMemoryConfigurationEpochStore, ConfigurationEpochError } from "./configuration-epoch";
import { createInMemoryEventStore } from "./test-support";

describe("acknowledged configuration epoch closure", () => {
  it("keeps the owner OPEN until every CLOSED-THROUGH receipt is durable", async () => {
    const store = createInMemoryConfigurationEpochStore();
    await store.open({ key: "channels.connection:acct_1", storeIncarnation: "owner-1", keyCreationEpoch: 3 });
    await store.registerConsumer("channels.connection:acct_1", {
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    await store.registerConsumer("channels.connection:acct_1", {
      consumerStoreId: "consumer-b",
      storeIncarnation: "consumer-1",
    });
    const grant = await store.captureGrant({
      key: "channels.connection:acct_1",
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    const closing = await store.beginClosure("channels.connection:acct_1", 3);
    expect(closing.pendingConsumerStoreIds).toEqual(["consumer-a", "consumer-b"]);
    expect(() => store.validateGrantVector([grant])).toThrow("not acknowledged");
    await store.acknowledgeClosedThrough({
      key: grant.key,
      epoch: 3,
      topologyRevision: closing.topologyRevision,
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    await expect(store.installClosure(grant.key, 3, closing.topologyRevision)).rejects.toMatchObject({
      details: { missingConsumerStoreIds: ["consumer-b"] },
    });
    await store.acknowledgeClosedThrough({
      key: grant.key,
      epoch: 3,
      topologyRevision: closing.topologyRevision,
      consumerStoreId: "consumer-b",
      storeIncarnation: "consumer-1",
    });
    await store.installClosure(grant.key, 3, closing.topologyRevision);
    const next = await store.captureGrant({
      key: grant.key,
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    expect(next.epoch).toBe(4);
  });

  it("rejects unknown, duplicate, expired and old-incarnation grants", async () => {
    const store = createInMemoryConfigurationEpochStore();
    await store.open({ key: "inventory.item:item_1", storeIncarnation: "owner-1", keyCreationEpoch: 0 });
    expect(() =>
      store.validateGrantVector([{ key: "inventory.item:item_1", epoch: 9, storeIncarnation: "owner-1" }]),
    ).toThrow(ConfigurationEpochError);
    const grant = await store.captureGrant({
      key: "inventory.item:item_1",
      consumerStoreId: "consumer",
      storeIncarnation: "consumer-1",
      validUntil: "2999-01-01T00:00:00.000Z",
    });
    expect(() => store.validateGrantVector([grant, grant])).toThrow("duplicate");
    expect(() => store.validateGrantVector([{ ...grant, validUntil: "2000-01-01T00:00:00.000Z" }])).toThrow("validity");
    expect(() => store.validateGrantVector([{ ...grant, storeIncarnation: "owner-2" }])).toThrow("not acknowledged");
  });

  it("does not allow registration or retirement to race CLOSING", async () => {
    const store = createInMemoryConfigurationEpochStore();
    await store.open({ key: "identity.account:acct_1", storeIncarnation: "owner-1" });
    await store.registerConsumer("identity.account:acct_1", {
      consumerStoreId: "consumer",
      storeIncarnation: "consumer-1",
    });
    await store.beginClosure("identity.account:acct_1", 0);
    await expect(
      store.registerConsumer("identity.account:acct_1", { consumerStoreId: "late", storeIncarnation: "late-1" }),
    ).rejects.toThrow("CLOSING");
    await expect(store.retireConsumer("identity.account:acct_1", "consumer", "consumer-1")).rejects.toThrow("CLOSING");
  });

  it("retains an acknowledged append when a later guarded append refuses", async () => {
    const configurationEpoch = createInMemoryConfigurationEpochStore();
    await configurationEpoch.open({ key: "channels.connection:acct_2", storeIncarnation: "owner-1" });
    const memory = createInMemoryEventStore({ configurationEpoch });
    const context = {
      tenantId: "tenant" as never,
      audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
    };
    await memory.eventStore.appendToStream({
      streamId: "stream",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "created", payload: {} }],
    });
    expect(() =>
      configurationEpoch.validateGrantVector([
        { key: "channels.connection:acct_2", epoch: 7, storeIncarnation: "owner-1" },
      ]),
    ).toThrow();
    await expect(
      memory.eventStore.appendToStream({
        streamId: "stream",
        expectedVersion: 1,
        configurationGrants: [{ key: "channels.connection:acct_2", epoch: 7, storeIncarnation: "owner-1" }],
        context,
        events: [{ eventType: "changed", payload: {} }],
      }),
    ).rejects.toThrow();
    await expect(memory.eventStore.readStream({ streamId: "stream" })).resolves.toHaveLength(1);
  });
});
