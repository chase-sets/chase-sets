import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createInventoryItemGradedCardAuthority } from "./graded-card-authority";

const stores = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => stores.current,
}));

const context = {
  tenantId: "tenant" as never,
  audit: { performedByUserId: "user" as never, forAccountId: "owner" as never },
};
const gradedCard = {
  gradingCompany: "PSA",
  grade: "10",
  certificationNumber: "12345678",
  population: { populationAtGrade: 12, populationHigher: 0, source: "PSA population report", asOf: "2026-04-01" },
  conditionDescriptors: ["Gem Mint"],
};

function created(itemId: string, recorded: Readonly<Record<string, unknown>>) {
  return {
    eventType: "inventory.item.created",
    payload: {
      itemId,
      accountId: "owner",
      catalogItemId: "cat_1",
      productId: "cat_1::",
      selectedOptions: [],
      storageLocationId: "location",
      totalQuantity: 2,
      acquisitionCostAmount: null,
      acquisitionCostCurrencyCode: null,
      ...recorded,
    },
  };
}

/** The authority over an in-memory store; the pool refuses every query, so only the stream can answer. */
function fixture() {
  const memory = createInMemoryEventStore();
  const append = (streamId: string, events: Parameters<typeof memory.eventStore.appendToStream>[0]["events"]) =>
    memory.eventStore.appendToStream({ streamId, expectedVersion: "no_stream", context, events });
  const readStream = vi.spyOn(memory.eventStore, "readStream");
  const appendToStream = vi.spyOn(memory.eventStore, "appendToStream");
  stores.current = memory.eventStore;
  const query = vi.fn(async (): Promise<never> => {
    throw new Error("the pool must not be queried");
  });
  const authority = createInventoryItemGradedCardAuthority({ query, connect: query });
  return { ...memory, append, appendToStream, authority, query, readStream };
}

describe("Inventory Item Graded Card Authority", () => {
  it.each([
    null,
    [],
    {},
    { accountId: "owner", inventoryItemId: { id: "item" } },
    { accountId: { id: "owner" }, inventoryItemId: "item" },
    { accountId: "owner", inventoryItemId: "item", gradedCard },
    { accountId: "", inventoryItemId: "item" },
    { accountId: "owner", inventoryItemId: "" },
  ])("closes authority input before any stream read: %j", async (input) => {
    const { authority, query, readStream } = fixture();

    await expect(authority.resolveInventoryItemGradedCard(input as never)).rejects.toThrow(
      "Invalid inventory item graded card authority input.",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a graded item", recorded: { gradedCard }, expected: gradedCard },
    { label: "a raw item", recorded: { gradedCard: null }, expected: null },
    { label: "an item recorded without the key", recorded: {}, expected: null },
  ])("returns the details recorded at creation for $label and its owner", async ({ recorded, expected }) => {
    const { append, authority } = fixture();
    await append("inventory.item-item", [created("item", recorded)]);

    await expect(
      authority.resolveInventoryItemGradedCard({ accountId: "owner", inventoryItemId: "item" }),
    ).resolves.toEqual({
      gradedCard: expected,
    });
  });

  it("keeps answering from the creation event after later events on the stream", async () => {
    const { append, authority } = fixture();
    await append("inventory.item-item", [
      created("item", { gradedCard }),
      { eventType: "inventory.item.adjusted", payload: { itemId: "item", quantityDelta: -1, reason: "sold" } },
    ]);

    await expect(
      authority.resolveInventoryItemGradedCard({ accountId: "owner", inventoryItemId: "item" }),
    ).resolves.toEqual({
      gradedCard,
    });
  });

  it("answers null for an unknown item, another account's item and a stream that does not start with creation", async () => {
    const { append, authority } = fixture();
    await append("inventory.item-item", [created("item", { gradedCard })]);
    await append("inventory.item-adjusted-first", [
      {
        eventType: "inventory.item.adjusted",
        payload: { itemId: "adjusted-first", quantityDelta: 1, reason: "found" },
      },
      created("adjusted-first", { gradedCard }),
    ]);
    await append("inventory.item-renamed", [created("item", { gradedCard })]);

    for (const input of [
      { accountId: "owner", inventoryItemId: "missing" },
      { accountId: "foreign", inventoryItemId: "item" },
      { accountId: "owner", inventoryItemId: "adjusted-first" },
      { accountId: "owner", inventoryItemId: "renamed" },
    ]) {
      await expect(authority.resolveInventoryItemGradedCard(input), JSON.stringify(input)).resolves.toBeNull();
    }
  });

  it("issues one read limited to one event per answer, queries no projection and appends nothing", async () => {
    const { allEvents, append, appendToStream, authority, query, readStream } = fixture();
    await append("inventory.item-item", [
      created("item", { gradedCard }),
      { eventType: "inventory.item.adjusted", payload: { itemId: "item", quantityDelta: -1, reason: "sold" } },
    ]);
    const stored = allEvents.length;
    appendToStream.mockClear();

    for (const [index, input] of [
      { accountId: "owner", inventoryItemId: "item" },
      { accountId: "foreign", inventoryItemId: "item" },
      { accountId: "owner", inventoryItemId: "missing" },
    ].entries()) {
      await authority.resolveInventoryItemGradedCard(input);
      expect(readStream).toHaveBeenCalledTimes(index + 1);
      expect(readStream).toHaveBeenLastCalledWith({
        streamId: `inventory.item-${input.inventoryItemId}`,
        fromVersion: 1,
        limit: 1,
      });
      await expect(readStream.mock.results[index]!.value).resolves.toHaveLength(
        input.inventoryItemId === "item" ? 1 : 0,
      );
    }

    expect(appendToStream).not.toHaveBeenCalled();
    expect(allEvents).toHaveLength(stored);
    expect(query).not.toHaveBeenCalled();
  });
});
