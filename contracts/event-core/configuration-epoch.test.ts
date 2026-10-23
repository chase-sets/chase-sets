import { describe, expect, it } from "vitest";
import { assertConfigurationGrantCurrent, replayConfigurationEpoch } from "./configuration-epoch";
import {
  createInMemoryConfigurationConsumer,
  createInMemoryConfigurationEpochStore,
} from "./configuration-epoch-memory";
import { createInMemoryEventStore } from "./test-support";

const identity = { storeId: "consumer", incarnation: "consumer-1" };
const context = {
  tenantId: "tenant" as never,
  audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
};
const input = {
  streamId: "terminal",
  expectedVersion: "no_stream" as const,
  context,
  events: [{ eventType: "test.committed", payload: {} }],
};
function setup() {
  const owner = createInMemoryConfigurationEpochStore("source-1");
  const consumer = createInMemoryConfigurationConsumer(identity, () => "2026-01-01T00:00:00Z");
  owner.open("owner/key", 3);
  owner.registerConsumer("owner/key", consumer);
  return { owner, consumer, memory: createInMemoryEventStore({ configurationEpoch: consumer }) };
}
describe("acknowledged configuration epochs in memory", () => {
  it("AC1 terminal first commits; CLOSED-THROUGH first refuses; next installed epoch commits", async () => {
    const { owner, consumer, memory } = setup();
    const grant = owner.captureGrant("owner/key", identity);
    owner.beginClosure("owner/key");
    // CLOSING stops capture, not already captured consumer-local terminals.
    await memory.eventStore.appendToStreams!([{ ...input, configurationGrants: [grant] }]);
    expect(() => owner.captureGrant("owner/key", identity)).toThrow();
    expect(() => owner.installClosure("owner/key")).toThrow("every CLOSED-THROUGH");
    owner.driveClosure("owner/key", [consumer]);
    await expect(
      memory.eventStore.appendToStreams!([{ ...input, streamId: "stale", configurationGrants: [grant] }]),
    ).rejects.toThrow("closed-through");
    owner.installClosure("owner/key");
    const next = owner.captureGrant("owner/key", identity);
    await memory.eventStore.appendToStreams!([{ ...input, streamId: "new", configurationGrants: [next] }]);
    expect(memory.allEvents).toHaveLength(2);
  });
  it("AC2 unavailable registered consumer blocks only its key and time releases nothing", () => {
    const { owner } = setup();
    owner.open("other/key");
    owner.beginClosure("owner/key");
    expect(owner.driveClosure("owner/key", []).status).toBe("BLOCKED");
    expect(owner.status("owner/key").pendingConsumers).toEqual([identity]);
    expect(() => owner.installClosure("owner/key")).toThrow();
    expect(owner.status("other/key").status).toBe("OPEN");
  });
  it("AC2 registration and retirement wait throughout CLOSING", () => {
    const { owner, consumer } = setup();
    owner.beginClosure("owner/key");
    expect(() => owner.retireConsumer("owner/key", identity)).toThrow();
    expect(() => owner.registerConsumer("owner/key", consumer)).toThrow();
  });
  it("AC2 absent history only admits the named creation epoch and incarnation", () => {
    const { owner, consumer } = setup();
    const grant = owner.captureGrant("owner/key", identity);
    consumer.validateGrantVector([grant]);
    expect(() => consumer.validateGrantVector([{ ...grant, epoch: 4 }])).toThrow();
    expect(() => consumer.validateGrantVector([{ ...grant, consumer: { ...identity, incarnation: "old" } }])).toThrow();
    expect(() => consumer.validateGrantVector([{ ...grant, validUntil: "2000-01-01" }])).toThrow();
    expect(() => consumer.validateGrantVector([grant, grant])).toThrow();
    expect(() => consumer.validateGrantVector(Array(33).fill(grant))).toThrow("32");
    expect(() => consumer.validateGrantVector([{ ...grant, validUntil: "unknown" }])).toThrow();
    expect(() => replayConfigurationEpoch([{ kind: "APPLIED", epoch: 3, topologyRevision: 1 }])).toThrow();
  });
  it("guard-bypass mutant is caught by the stale-terminal oracle", () => {
    const { owner, consumer } = setup();
    const grant = owner.captureGrant("owner/key", identity);
    owner.beginClosure("owner/key");
    owner.driveClosure("owner/key", [consumer]);
    const oracle = (bypassGuard: boolean) => {
      const terminal = () => {
        if (!bypassGuard)
          assertConfigurationGrantCurrent(grant, identity, consumer.guards.get(grant.key), "2026-01-01");
      };
      expect(terminal).toThrow();
    };
    oracle(false);
    expect(() => oracle(true)).toThrow();
  });
});
