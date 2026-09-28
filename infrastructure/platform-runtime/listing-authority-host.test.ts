import { expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityParticipantPort } from "@chase-sets/event-core/listing-authority";
import { createListingAuthorityFence } from "./listing-authority-fence";
import { bindListingAuthorityParticipant, createListingAuthorityConsumerResolver } from "./listing-authority-host";

it.each(["marketplace", "ordering"] as const)(
  "routes %s terminals through the actual store with a fixed source identity",
  async (owner) => {
    const stores = {
      marketplace: createInMemoryEventStore().eventStore,
      ordering: createInMemoryEventStore().eventStore,
    };
    const fence = createListingAuthorityFence({ eventStore: stores[owner], owner, participants: [] });
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
    };
    const operation = await fence.open(
      {
        tenantId: context.tenantId,
        accountId: context.audit.forAccountId,
        actor: { kind: "user", userId: context.audit.performedByUserId },
        committingOwner: owner,
        kind: "native-commitment",
        requestId: "synthetic-request",
        command: {},
        listingId: "lst_synthetic",
        subject: {
          inventoryItemId: "inv_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          selectedOptions: [],
          quantity: 1,
          pair: null,
          allocationRevision: null,
          commitmentSourceId: null,
        },
        target: { kind: "native-marketplace" },
        expectedListingRevision: 1,
        expectedTargetRevision: null,
        expectedVisibilityRevision: null,
        expectedPublicationRevision: null,
        participants: [{ owner: "catalog", purpose: "product-measures" }],
      },
      context,
    );
    const consumer = createListingAuthorityConsumerResolver(stores, "catalog")(operation);
    expect((await consumer.inspect(operation)).status).toBe("pending");
    await consumer.invalidate(operation, "synthetic-source-changed");
    expect(await fence.inspect(operation)).toMatchObject({
      status: "aborted",
      reason: "catalog:synthetic-source-changed",
    });
    const other = owner === "marketplace" ? "ordering" : "marketplace";
    expect(await stores[other].readAll()).toEqual([]);
    await expect(createListingAuthorityConsumerResolver(stores, "auth")(operation).inspect(operation)).rejects.toThrow(
      "Unbound authority owner",
    );
    expect(() => createListingAuthorityConsumerResolver({}, "catalog")(operation)).toThrow("not mounted");
  },
);

it("binds deferred owner APIs without silently replacing their participant identity", async () => {
  const original: ListingAuthorityParticipantPort = {
    participant: { owner: "catalog", purpose: "product-measures" },
    prepare: vi.fn(),
    inspect: vi.fn(async () => null),
    settle: vi.fn(),
  };
  let mounted = original;
  const port = bindListingAuthorityParticipant(original.participant, () => mounted);
  const operation = {} as Parameters<typeof port.inspect>[0];
  expect(await port.inspect(operation)).toBeNull();
  expect(original.inspect).toHaveBeenCalledExactlyOnceWith(operation);
  mounted = { ...original, participant: { owner: "inventory", purpose: "stock-allocation" } };
  expect(() => port.inspect(operation)).toThrow("identity changed");
});
