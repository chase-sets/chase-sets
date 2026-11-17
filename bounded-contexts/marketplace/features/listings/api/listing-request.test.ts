import { describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createInMemoryEventStore, createInMemoryConfigurationConsumer } from "@chase-sets/event-core/test-support";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { createListingRequestExecutor, ListingRequestIndeterminateError } from "./listing-request";

async function fixture(commit = true) {
  const consumer = createInMemoryConfigurationConsumer({ storeId: "marketplace", incarnation: "consumer" });
  const memory = createInMemoryEventStore({ configurationEpoch: consumer });
  const context = {
    tenantId: createId("tnt"),
    audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
  };
  const input = {
    accountId: context.audit.forAccountId,
    idempotencyKey: "request",
    command: { listingId: "listing", priceAmount: "10.00", priceCurrencyCode: "USD", expectedListingVersion: 1 },
    context,
    principal: {
      userId: context.audit.performedByUserId,
      membershipId: "membership",
      sessionId: "session",
      tokenHash: "hash",
    },
    parseResult(value: unknown) {
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 2)
        throw new Error("corrupt result");
      return { version: value.version };
    },
    prepare: vi.fn(async () => ({
      result: { version: 2 },
      evidence: [{ owner: "identity", key: "account/account", storeIncarnation: "identity", sealVersion: 1, epoch: 0 }],
      appends: [
        {
          streamId: "marketplace.listing-listing",
          expectedVersion: "no_stream" as const,
          context,
          configurationGrants: [
            {
              key: "account/account",
              sourceIncarnation: "identity",
              keyCreationEpoch: 0,
              epoch: 0,
              consumer: consumer.identity,
              topologyRevision: 1,
            },
          ],
          events: [{ eventType: "test.listing.changed", payload: {} }],
        },
      ],
    })),
  };
  const execute = createListingRequestExecutor(memory.eventStore);
  if (commit) await execute(input);
  return { memory, input, execute };
}

describe("Listing request replay", () => {
  it("keeps an initial read outage indeterminate and retries the same command after recovery", async () => {
    const f = await fixture(false);
    let unavailable = true;
    const append = vi.fn(f.memory.eventStore.appendToStreams!);
    const execute = createListingRequestExecutor({
      ...f.memory.eventStore,
      async readStream(input) {
        if (unavailable) throw new Error("storage unavailable");
        return f.memory.eventStore.readStream(input);
      },
      appendToStreams: append,
    });
    await expect(execute(f.input)).rejects.toBeInstanceOf(ListingRequestIndeterminateError);
    expect(f.input.prepare).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(f.memory.allEvents).toHaveLength(0);
    unavailable = false;
    expect(await execute(f.input)).toEqual({ version: 2 });
    expect(await execute(f.input)).toEqual({ version: 2 });
    expect(f.input.prepare).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(f.memory.allEvents).toHaveLength(2);
  });
  it.each([false, true])(
    "recovers a lost COMMIT acknowledgement with result reread unavailable=%s",
    async (unavailable) => {
      const f = await fixture(false);
      let committed = false;
      const append = vi.fn(async (inputs: Parameters<NonNullable<typeof f.memory.eventStore.appendToStreams>>[0]) => {
        await f.memory.eventStore.appendToStreams!(inputs);
        committed = true;
        throw new Error("lost COMMIT acknowledgement");
      });
      const execute = createListingRequestExecutor({
        ...f.memory.eventStore,
        async readStream(input) {
          if (committed && unavailable) throw new Error("result reread unavailable");
          return f.memory.eventStore.readStream(input);
        },
        appendToStreams: append,
      });
      if (unavailable) await expect(execute(f.input)).rejects.toBeInstanceOf(ListingRequestIndeterminateError);
      else expect(await execute(f.input)).toEqual({ version: 2 });
      expect(f.memory.allEvents).toHaveLength(2);
      unavailable = false;
      expect(await execute(f.input)).toEqual({ version: 2 });
      expect(f.input.prepare).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(1);
      expect(f.memory.allEvents).toHaveLength(2);
    },
  );
  it("keeps an unknown append failure indeterminate without inventing a result", async () => {
    const f = await fixture(false);
    const execute = createListingRequestExecutor({
      ...f.memory.eventStore,
      async appendToStreams() {
        throw new Error("storage connection lost");
      },
    });
    await expect(execute(f.input)).rejects.toBeInstanceOf(ListingRequestIndeterminateError);
    expect(f.memory.allEvents).toHaveLength(0);
    expect(await f.execute(f.input)).toEqual({ version: 2 });
    expect(f.memory.allEvents).toHaveLength(2);
  });
  it.each(["concurrency_conflict", "payload_too_large"] as const)(
    "preserves deterministic append refusal %s",
    async (code) => {
      const f = await fixture(false);
      const refusal = createEventStoreError(code, "deterministic refusal");
      const execute = createListingRequestExecutor({
        ...f.memory.eventStore,
        async appendToStreams() {
          throw refusal;
        },
      });
      await expect(execute(f.input)).rejects.toBe(refusal);
      expect(f.memory.allEvents).toHaveLength(0);
    },
  );
  it("preserves a deterministic preparation refusal", async () => {
    const f = await fixture(false);
    const refusal = new Error("domain refusal");
    f.input.prepare.mockRejectedValue(refusal);
    await expect(f.execute(f.input)).rejects.toBe(refusal);
    expect(f.memory.allEvents).toHaveLength(0);
  });
  it("returns the original result without preparing again", async () => {
    const f = await fixture();
    expect(await f.execute(f.input)).toEqual({ version: 2 });
    expect(f.input.prepare).toHaveBeenCalledTimes(1);
    expect(f.memory.allEvents).toHaveLength(2);
  });
  it("fingerprints currency, versions, target and the real principal", async () => {
    const f = await fixture();
    for (const command of [
      { ...f.input.command, priceCurrencyCode: "EUR" },
      { ...f.input.command, expectedListingVersion: 2 },
      { ...f.input.command, listingId: "other" },
    ]) {
      await expect(f.execute({ ...f.input, command })).rejects.toThrow("different command");
    }
    await expect(f.execute({ ...f.input, principal: { ...f.input.principal, sessionId: "other" } })).rejects.toThrow(
      "different command",
    );
    await expect(f.execute({ ...f.input, principal: { ...f.input.principal, tokenHash: "other" } })).rejects.toThrow(
      "different command",
    );
    await expect(
      f.execute({
        ...f.input,
        context: { ...f.input.context, audit: { ...f.input.context.audit, performedByUserId: createId("usr") } },
      }),
    ).rejects.toThrow("different command");
  });
  it.each([
    "duplicate",
    "second-event",
    "wrong-type",
    "wrong-version",
    "wrong-tenant",
    "missing-evidence",
    "missing-result",
    "invalid-result",
  ])("refuses poisoned %s history", async (mutation) => {
    const f = await fixture();
    const store = {
      ...f.memory.eventStore,
      readStream: async (
        input: Parameters<typeof f.memory.eventStore.readStream>[0],
      ): Promise<readonly StoredEvent[]> => {
        const events = await f.memory.eventStore.readStream(input);
        if (!input.streamId.startsWith("marketplace.listing-request-") || !events.length) return events;
        const event = events[0];
        if (mutation === "duplicate") return [event, event];
        if (mutation === "second-event") return [event, { ...event, eventId: createId("evt"), streamVersion: 2 }];
        if (mutation === "wrong-type") return [{ ...event, eventType: "other" }];
        if (mutation === "wrong-version") return [{ ...event, streamVersion: 2 }];
        if (mutation === "wrong-tenant") return [{ ...event, tenantId: createId("tnt") }];
        if (mutation === "missing-evidence")
          return [{ ...event, payload: { ...event.payload, authorizationEvidence: [] } }];
        if (mutation === "missing-result") return [{ ...event, payload: { ...event.payload, result: undefined } }];
        return [{ ...event, payload: { ...event.payload, result: {} } }];
      },
    };
    await expect(createListingRequestExecutor(store)(f.input)).rejects.toThrow("corrupt history");
    expect(f.input.prepare).toHaveBeenCalledTimes(1);
    expect(f.memory.allEvents).toHaveLength(2);
  });
});
