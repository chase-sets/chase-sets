import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import type { ListingAuthorityOperationInput } from "@chase-sets/platform-runtime/listing-authority-fence";
import {
  listingAuthorityConformance,
  listingAuthorityOwnerConformance,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createChannelConnectionRuntime } from "../api/runtime";
import { ChannelConnectionMutationPendingError, createChannelConnectionAuthority } from "../api/listing-authority";
import { activateFixture, connectFixture, createConnectionHarness, testContext } from "./test-support";

async function fixture() {
  const memory = createInMemoryEventStore();
  const consumer = createInMemoryEventStore();
  const { ports } = createConnectionHarness();
  function restart() {
    const source = createChannelConnectionAuthority(memory.eventStore, () => fence.forParticipant("channels")).source;
    const fence = createListingAuthorityFence({
      eventStore: consumer.eventStore,
      owner: "marketplace",
      participants: [source],
    });
    const services = createChannelConnectionRuntime(
      {
        eventStore: memory.eventStore,
        db: {
          query: async () => {
            throw new Error("Projection is not authority.");
          },
        },
      },
      { ...ports, listingAuthorityConsumer: () => fence.forParticipant("channels") },
    );
    const input: ListingAuthorityOperationInput = {
      tenantId: testContext.tenantId,
      accountId: testContext.audit.forAccountId,
      actor: { kind: "user", userId: testContext.audit.performedByUserId },
      committingOwner: "marketplace",
      kind: "accept-price",
      requestId: "synthetic-connection-acceptance",
      command: { amount: "12.00", currencyCode: "USD" },
      listingId: "lst_synthetic",
      subject: {
        inventoryItemId: "inv_synthetic",
        catalogItemId: "cat_synthetic",
        productId: "cat_synthetic::",
        selectedOptions: [],
        quantity: 1,
        pair: { amount: "12.00", currencyCode: "USD" },
        allocationRevision: null,
        commitmentSourceId: null,
      },
      target: { kind: "channel-connection", connectionId: "connection_1" },
      expectedListingRevision: 1,
      expectedTargetRevision: 0,
      expectedVisibilityRevision: null,
      expectedPublicationRevision: null,
      participants: [{ owner: "channels", purpose: "connection" }],
    };
    return {
      memory,
      services,
      source,
      fence,
      input,
      restart,
      context: testContext,
      sourceStore: memory.eventStore,
      consumerStore: consumer.eventStore,
      invalidate: async () => {
        await services.disconnectChannelConnection(
          { accountId: "acc_owner", connectionId: "connection_1" },
          testContext,
        );
      },
    };
  }
  const f = restart();
  await connectFixture(f.services);
  await connectFixture(f.services, "con_synthetic_second");
  return f;
}

describe("Channels connection shared authority conformance", () => listingAuthorityConformance(it, fixture));

describe("Channels connection owner proofs", () => {
  listingAuthorityOwnerConformance(it, "channels", {
    disconnectAndConnectionIdentityWriters: async () => {
      const f = await fixture();
      for (const [index, write] of [
        () => activateFixture(f.services),
        () => f.services.pauseChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext),
        () => f.services.resumeChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext),
        () => f.invalidate(),
      ].entries()) {
        const operation = await f.fence.open({ ...f.input, requestId: `synthetic-writer-${index}` }, testContext);
        const grant = await f.source.prepare(operation, testContext);
        expect(grant.value).toMatchObject({
          accountId: "acc_owner",
          providerKey: "fixture-provider",
          environment: "sandbox",
          revision: index + 1,
        });
        const stale = await f.fence.prepareCommit(operation, [grant], { accepted: true });
        await write();
        expect((await f.fence.inspect(operation)).status).toBe("aborted");
        await expect(f.consumerStore.appendToStreams!([...stale])).rejects.toThrow();
        await f.source.settle(operation);
      }
      await expect(connectFixture(f.services)).rejects.toMatchObject({ code: "connection-disconnected" });
    },
    retainedAcceptanceWithoutProviderTransport: async () => {
      const f = await fixture();
      const services = createChannelConnectionRuntime(
        {
          eventStore: f.sourceStore,
          db: {
            query: async () => {
              throw new Error("No projection");
            },
          },
        },
        { listingAuthorityConsumer: () => f.fence.forParticipant("channels") },
      );
      const operation = await f.fence.open(f.input, testContext);
      const grant = await services.listingAuthority.prepare(operation, testContext);
      expect(grant.value).toMatchObject({
        status: "pending-setup",
        providerKey: "fixture-provider",
        environment: "sandbox",
      });
      await f.consumerStore.appendToStreams!([
        ...(await f.fence.prepareCommit(operation, [grant], { accepted: true })),
      ]);
      await services.listingAuthority.settle(operation);
      expect((await f.fence.inspect(operation)).status).toBe("committed");
    },
  });

  it("fails closed for absent, foreign, native, disconnected and corrupt connection authority", async () => {
    const f = await fixture();
    for (const target of [
      { kind: "native-marketplace" } as const,
      { kind: "channel-connection", connectionId: "absent" } as const,
    ]) {
      const operation = await f.fence.open({ ...f.input, requestId: `synthetic-${target.kind}`, target }, testContext);
      await expect(f.source.prepare(operation, testContext)).rejects.toThrow();
    }
    const context = { ...testContext, audit: { ...testContext.audit, forAccountId: "acc_foreign" as never } };
    const foreign = await f.fence.open(
      { ...f.input, requestId: "synthetic-foreign", accountId: context.audit.forAccountId },
      context,
    );
    await expect(f.source.prepare(foreign, context)).rejects.toThrow();
    const operation = await f.fence.open(f.input, testContext);
    const row = f.memory.streams.get("channels.connection-connection_1")![0]!;
    f.memory.streams.set(row.streamId, [{ ...row, payload: { ...row.payload, environment: "unknown" } }]);
    await expect(f.source.prepare(operation, testContext)).rejects.toThrow();
  });

  it("an unmounted runtime cannot grant or disconnect past an outstanding promise", async () => {
    const f = await fixture();
    const unmounted = createChannelConnectionRuntime({
      eventStore: f.sourceStore,
      db: { query: async () => ({ rows: [] }) },
    });
    const operation = await f.fence.open(f.input, testContext);
    await expect(unmounted.listingAuthority.prepare(operation, testContext)).rejects.toThrow("not mounted");
    await f.source.prepare(operation, testContext);
    await expect(
      unmounted.disconnectChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext),
    ).rejects.toBeInstanceOf(ChannelConnectionMutationPendingError);
    expect((await f.fence.inspect(operation)).status).toBe("pending");
    await expect(
      f.source.prepare(
        await f.fence.open({ ...f.input, requestId: "synthetic-after-closure" }, testContext),
        testContext,
      ),
    ).rejects.toThrow("pending invalidation");
  });

  it("persists closure before an ambiguous abort and resumes the same mutation after restart", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, testContext);
    await f.source.prepare(operation, testContext);
    const broken = createChannelConnectionRuntime(
      { eventStore: f.sourceStore, db: { query: async () => ({ rows: [] }) } },
      {
        listingAuthorityConsumer: () => ({
          inspect: f.fence.inspect,
          invalidate: async (op, reason) => {
            await f.fence.abort(op, reason);
            throw new Error("Synthetic lost abort reply");
          },
        }),
      },
    );
    const error = await broken
      .disconnectChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ChannelConnectionMutationPendingError);
    const mutationId = (error as ChannelConnectionMutationPendingError).mutationId;
    expect((await f.source.inspectInvalidation(testContext.tenantId, mutationId))?.status).toBe("pending");
    expect(f.memory.streams.get("channels.connection-connection_1")).toHaveLength(1);
    const second = await f.fence.open(
      {
        ...f.input,
        requestId: "synthetic-unrelated",
        target: { kind: "channel-connection", connectionId: "con_synthetic_second" },
      },
      testContext,
    );
    await f.source.prepare(second, testContext);
    const restarted = f.restart();
    const result = await restarted.services.recoverAuthorityMutation(mutationId, testContext);
    expect(result.map((event) => event.eventType)).toEqual(["channels.connection.disconnected"]);
    expect(await restarted.services.recoverAuthorityMutation(mutationId, testContext)).toEqual(result);
    expect((await f.source.inspectInvalidation(testContext.tenantId, mutationId))?.status).toBe("completed");
    expect((await f.fence.inspect(second)).status).toBe("pending");
  });

  it("recovers a lost source completion reply without a second business event", async () => {
    const f = await fixture();
    const append = f.sourceStore.appendToStreams!.bind(f.sourceStore);
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementation(async (inputs) => {
      const result = await append(inputs);
      if (inputs.some((input) => input.events.some((event) => event.eventType === "channels.connection.disconnected")))
        throw new Error("Synthetic lost source reply");
      return result;
    });
    await f.invalidate();
    expect(f.memory.streams.get("channels.connection-connection_1")?.map((event) => event.eventType)).toEqual([
      "channels.connection.connected",
      "channels.connection.disconnected",
    ]);
  });

  it("rejects a source change during reservation acquisition without leaving a grant", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, testContext);
    const append = f.sourceStore.appendToStreams!.bind(f.sourceStore);
    let raced = false;
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementation(async (inputs) => {
      if (
        !raced &&
        inputs.some((input) => input.events.some((event) => event.eventType === "channels.listing-authority.reserved"))
      ) {
        raced = true;
        await f.invalidate();
      }
      return append(inputs);
    });
    await expect(f.source.prepare(operation, testContext)).rejects.toMatchObject({ code: "connection-disconnected" });
    expect(await f.source.inspect(operation)).toBeNull();
  });

  it("cannot reserve a missing connection or replace immutable ownership and binding after creation", async () => {
    const f = await fixture();
    const operation = await f.fence.open(
      { ...f.input, target: { kind: "channel-connection", connectionId: "synthetic-new" } },
      testContext,
    );
    await expect(f.source.prepare(operation, testContext)).rejects.toMatchObject({ code: "connection-not-found" });
    await connectFixture(f.services, "synthetic-new");
    const grant = await f.source.prepare(operation, testContext);
    expect(grant.resources).toEqual(["connection/synthetic-new"]);
    await expect(
      f.services.connectChannel(
        { connectionId: "synthetic-new", accountId: "acc_owner", providerKey: "different-provider" },
        { deploymentEnvironment: "production" },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "invalid-transition" });
    const foreignContext = { ...testContext, tenantId: "tnt_foreign" as never };
    await expect(
      f.services.disconnectChannelConnection({ connectionId: "synthetic-new", accountId: "acc_owner" }, foreignContext),
    ).rejects.toThrow();
    expect((await f.fence.inspect(operation)).status).toBe("pending");
    expect((await f.source.inspect(operation))?.value).toMatchObject({
      providerKey: "fixture-provider",
      environment: "sandbox",
      accountId: "acc_owner",
    });
  });

  it("recovers a lost prepare reply and discovers terminal acknowledgements after restart", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, testContext);
    const append = f.sourceStore.appendToStreams!.bind(f.sourceStore);
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementation(async (inputs) => {
      const result = await append(inputs);
      if (
        inputs.some((input) => input.events.some((event) => event.eventType === "channels.listing-authority.reserved"))
      )
        throw new Error("Synthetic lost prepare reply");
      return result;
    });
    const grant = await f.source.prepare(operation, testContext);
    await f.consumerStore.appendToStreams!([...(await f.fence.prepareCommit(operation, [grant], { accepted: true }))]);
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
    expect(await f.restart().services.recoverAuthorityPage({ tenantId: testContext.tenantId })).toEqual({
      nextCursor: null,
    });
    expect((await f.source.inspect(operation))?.status).toBe("consumed");
  });

  it("discovers an interrupted mutation from durable history without its caller retaining the identity", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, testContext);
    await f.source.prepare(operation, testContext);
    const unmounted = createChannelConnectionRuntime({
      eventStore: f.sourceStore,
      db: { query: async () => ({ rows: [] }) },
    });
    await expect(
      unmounted.disconnectChannelConnection({ accountId: "acc_owner", connectionId: "connection_1" }, testContext),
    ).rejects.toBeInstanceOf(ChannelConnectionMutationPendingError);
    await f.restart().services.recoverAuthorityPage({ tenantId: testContext.tenantId });
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    await f.restart().services.recoverAuthorityPage({ tenantId: testContext.tenantId });
    expect((await f.source.inspect(operation))?.status).toBe("released");
    expect(f.memory.streams.get("channels.connection-connection_1")).toHaveLength(2);
  });

  it("bounds connection fan-out without blocking unrelated targets", async () => {
    const f = await fixture();
    for (let index = 0; index < 128; index += 1) {
      const operation = await f.fence.open({ ...f.input, requestId: `synthetic-bound-${index}` }, testContext);
      await f.source.prepare(operation, testContext);
    }
    const overflow = await f.fence.open({ ...f.input, requestId: "synthetic-overflow" }, testContext);
    await expect(f.source.prepare(overflow, testContext)).rejects.toThrow("full");
    const other = await f.fence.open(
      {
        ...f.input,
        requestId: "synthetic-other-bound",
        target: { kind: "channel-connection", connectionId: "con_synthetic_second" },
      },
      testContext,
    );
    await f.source.prepare(other, testContext);
    await f.invalidate();
    expect((await f.fence.inspect(other)).status).toBe("pending");
  });

  it("retains closure and promises when authoritative consumer history is missing", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, testContext);
    await f.source.prepare(operation, testContext);
    const read = f.consumerStore.readStream.bind(f.consumerStore);
    vi.spyOn(f.consumerStore, "readStream").mockImplementation((input) =>
      input.streamId.includes(operation.operationId) ? Promise.resolve([]) : read(input),
    );
    await expect(f.invalidate()).rejects.toBeInstanceOf(ChannelConnectionMutationPendingError);
    await expect(f.source.settle(operation)).rejects.toThrow("unresolved");
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
    expect(f.memory.streams.get("channels.connection-connection_1")).toHaveLength(1);
    await expect(f.services.recoverAuthorityPage({ tenantId: testContext.tenantId })).rejects.toThrow("Unknown");
  });
});
