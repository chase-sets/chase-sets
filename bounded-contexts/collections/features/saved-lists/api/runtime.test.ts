import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type {
  SavedListCommandId,
  SavedListId,
  SavedListLineId,
  SavedListProductCatalog,
  SavedListProductSelection,
} from "../domain/contracts";
import { createSavedListRuntime, SavedListAuthorizationError, SavedListIdempotencyConflictError } from "./runtime";

const listId = "svl_test" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: ownerAccountId },
};

function commandId(value: string) {
  return `slc_${value}` as SavedListCommandId;
}

function lineId(value: string) {
  return `sll_${value}` as SavedListLineId;
}

function product(value: string): SavedListProductSelection {
  const catalogItemId = `cat_${value}` as CatalogItemId;
  return {
    catalogItemId,
    productId: `${catalogItemId}::condition:near-mint` as ProductKey,
    selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
  };
}

function activeCatalog(): SavedListProductCatalog {
  return {
    resolveProduct: vi.fn(async (selection: SavedListProductSelection) => ({
      availability: "active" as const,
      product: selection,
    })),
  };
}

async function setup(productCatalog: SavedListProductCatalog = activeCatalog()) {
  const store = createInMemoryEventStore();
  const runtime = createSavedListRuntime({
    eventStore: store.eventStore,
    productCatalog,
    clock: () => "2026-07-13T12:00:00.000Z",
  });
  const created = await runtime.createSavedList(
    { commandId: commandId("create"), listId, ownerAccountId, title: "Trade targets" },
    context,
  );
  return { ...store, runtime, created };
}

describe("Saved List command runtime", () => {
  it("returns authoritative snapshots and durable idempotent receipts", async () => {
    const store = createInMemoryEventStore();
    const runtime = createSavedListRuntime({
      eventStore: store.eventStore,
      productCatalog: activeCatalog(),
      clock: () => "2026-07-13T12:00:00.000Z",
    });
    const input = { commandId: commandId("create"), listId, ownerAccountId, title: "Trade targets" } as const;

    const first = await runtime.createSavedList(input, context);
    const replay = await runtime.createSavedList(input, context);

    expect(first).toMatchObject({
      receipt: {
        schemaVersion: "collections.saved-list-command-receipt.v1",
        outcome: "created",
        previousVersion: 0,
        committedVersion: 1,
        replayed: false,
      },
      savedList: { version: 1, visibility: "private", identity: { listId, ownerAccountId } },
    });
    expect(replay.receipt).toMatchObject({ outcome: "created", committedVersion: 1, replayed: true });
    expect(store.allEvents).toHaveLength(1);
    expect(store.allEvents[0]?.metadata.savedListCommandReceipt).toMatchObject({
      commandId: commandId("create"),
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    await expect(runtime.createSavedList({ ...input, title: "Different" }, context)).rejects.toBeInstanceOf(
      SavedListIdempotencyConflictError,
    );
  });

  it("merges duplicate Products, preserves stable lines, and returns deterministic partial batch errors", async () => {
    const catalog: SavedListProductCatalog = {
      resolveProduct: vi.fn(async (selection: SavedListProductSelection) => {
        if (selection.catalogItemId === "cat_retired") {
          return { availability: "retired" as const, product: selection };
        }
        if (selection.catalogItemId === "cat_missing") {
          return { availability: "missing" as const, product: null };
        }
        return { availability: "active" as const, product: selection };
      }),
    };
    const { runtime, allEvents } = await setup(catalog);
    const result = await runtime.applyLineChanges(
      {
        commandId: commandId("batch"),
        listId,
        ownerAccountId,
        expectedVersion: 1,
        operations: [
          {
            operationId: "one",
            kind: "add",
            lineId: lineId("one"),
            product: product("one"),
            trackedQuantity: 2,
            privateNotes: "private acquisition target",
          },
          { operationId: "two", kind: "add", lineId: lineId("ignored"), product: product("one"), trackedQuantity: 3 },
          {
            operationId: "retired",
            kind: "add",
            lineId: lineId("retired"),
            product: product("retired"),
            trackedQuantity: 1,
          },
          {
            operationId: "missing",
            kind: "add",
            lineId: lineId("missing"),
            product: product("missing"),
            trackedQuantity: 1,
          },
          { operationId: "missing-line", kind: "remove", lineId: lineId("absent") },
        ],
      },
      context,
    );

    expect(result.receipt).toMatchObject({
      outcome: "line-changes-applied",
      previousVersion: 1,
      committedVersion: 3,
      lineResults: [
        { operationId: "one", status: "added", lineId: lineId("one"), error: null },
        { operationId: "two", status: "merged", lineId: lineId("one"), error: null },
        { operationId: "retired", status: "rejected", error: { code: "product-retired" } },
        { operationId: "missing", status: "rejected", error: { code: "product-not-found" } },
        { operationId: "missing-line", status: "rejected", error: { code: "line-not-found" } },
      ],
    });
    expect(result.savedList.lines).toHaveLength(1);
    expect(result.savedList.lines[0]).toMatchObject({ lineId: lineId("one"), trackedQuantity: 5 });
    expect(allEvents).toHaveLength(3);
    expect(JSON.stringify(allEvents.slice(1).map((event) => event.metadata))).not.toContain(
      "private acquisition target",
    );

    const replay = await runtime.applyLineChanges(
      {
        commandId: commandId("batch"),
        listId,
        ownerAccountId,
        expectedVersion: 1,
        operations: [
          {
            operationId: "one",
            kind: "add",
            lineId: lineId("one"),
            product: product("one"),
            trackedQuantity: 2,
            privateNotes: "private acquisition target",
          },
          { operationId: "two", kind: "add", lineId: lineId("ignored"), product: product("one"), trackedQuantity: 3 },
          {
            operationId: "retired",
            kind: "add",
            lineId: lineId("retired"),
            product: product("retired"),
            trackedQuantity: 1,
          },
          {
            operationId: "missing",
            kind: "add",
            lineId: lineId("missing"),
            product: product("missing"),
            trackedQuantity: 1,
          },
          { operationId: "missing-line", kind: "remove", lineId: lineId("absent") },
        ],
      },
      context,
    );
    expect(replay.receipt.replayed).toBe(true);
    expect(allEvents).toHaveLength(3);
  });

  it("returns a recoverable concurrency conflict with the authoritative current snapshot", async () => {
    const { runtime } = await setup();
    await expect(
      runtime.changeDetails(
        {
          commandId: commandId("stale"),
          listId,
          ownerAccountId,
          expectedVersion: 0,
          title: "Stale title",
        },
        context,
      ),
    ).rejects.toMatchObject({
      name: "SavedListConcurrencyConflictError",
      expectedVersion: 0,
      currentVersion: 1,
      savedList: { version: 1, title: "Trade targets" },
    });
  });

  it("conceals cross-account lists and requires audit account authority", async () => {
    const { runtime } = await setup();
    const otherAccountId = "acc_other" as AccountId;
    const otherContext = {
      ...context,
      audit: { ...context.audit, forAccountId: otherAccountId },
    };

    await expect(
      runtime.getOwnerSnapshot({ listId, ownerAccountId: otherAccountId }, otherContext),
    ).rejects.toBeInstanceOf(SavedListAuthorizationError);
    await expect(
      runtime.changeVisibility(
        {
          commandId: commandId("unauthorized"),
          listId,
          ownerAccountId,
          expectedVersion: 1,
          visibility: "public",
        },
        otherContext,
      ),
    ).rejects.toBeInstanceOf(SavedListAuthorizationError);
    await expect(
      runtime.createSavedList(
        { commandId: commandId("create"), listId, ownerAccountId: otherAccountId, title: "Probe" },
        otherContext,
      ),
    ).rejects.toBeInstanceOf(SavedListAuthorizationError);
  });

  it("allows safe changes and removal after a Product retires without revalidating Catalog", async () => {
    let retired = false;
    const catalog: SavedListProductCatalog = {
      resolveProduct: vi.fn(async (selection: SavedListProductSelection) => ({
        availability: retired ? ("retired" as const) : ("active" as const),
        product: selection,
      })),
    };
    const { runtime } = await setup(catalog);
    const added = await runtime.applyLineChanges(
      {
        commandId: commandId("add"),
        listId,
        ownerAccountId,
        expectedVersion: 1,
        operations: [
          {
            operationId: "add",
            kind: "add",
            lineId: lineId("one"),
            product: product("one"),
            trackedQuantity: 1,
            privateNotes: "keep this note",
            privateTags: ["keep"],
          },
        ],
      },
      context,
    );
    retired = true;
    const changed = await runtime.applyLineChanges(
      {
        commandId: commandId("change-retired"),
        listId,
        ownerAccountId,
        expectedVersion: added.savedList.version,
        operations: [{ operationId: "change", kind: "change", lineId: lineId("one"), trackedQuantity: 2 }],
      },
      context,
    );

    expect(changed.receipt.lineResults.map((result) => result.status)).toEqual(["changed"]);
    expect(changed.savedList.lines[0]).toMatchObject({
      trackedQuantity: 2,
      privateNotes: "keep this note",
      privateTags: ["keep"],
    });
    expect(catalog.resolveProduct).toHaveBeenCalledTimes(1);

    const removed = await runtime.applyLineChanges(
      {
        commandId: commandId("remove-retired"),
        listId,
        ownerAccountId,
        expectedVersion: changed.savedList.version,
        operations: [{ operationId: "remove", kind: "remove", lineId: lineId("one") }],
      },
      context,
    );
    expect(removed.savedList.lines).toEqual([]);
    expect(catalog.resolveProduct).toHaveBeenCalledTimes(1);
  });

  it("rejects every archived-list operation before consulting Catalog", async () => {
    const catalog = activeCatalog();
    const { runtime } = await setup(catalog);
    const archived = await runtime.archiveSavedList(
      { commandId: commandId("archive"), listId, ownerAccountId, expectedVersion: 1 },
      context,
    );
    vi.mocked(catalog.resolveProduct).mockClear();

    const result = await runtime.applyLineChanges(
      {
        commandId: commandId("archived-batch"),
        listId,
        ownerAccountId,
        expectedVersion: archived.savedList.version,
        operations: [
          { operationId: "add", kind: "add", lineId: lineId("one"), product: product("one"), trackedQuantity: 1 },
          { operationId: "remove", kind: "remove", lineId: lineId("missing") },
        ],
      },
      context,
    );

    expect(result.receipt).toMatchObject({
      outcome: "no-change",
      lineResults: [
        { operationId: "add", status: "rejected", error: { code: "list-archived" } },
        { operationId: "remove", status: "rejected", error: { code: "list-archived" } },
      ],
    });
    expect(catalog.resolveProduct).not.toHaveBeenCalled();
  });

  it("bounds batch size before Catalog or event-store work", async () => {
    const { runtime } = await setup();
    await expect(
      runtime.applyLineChanges(
        {
          commandId: commandId("too-many"),
          listId,
          ownerAccountId,
          expectedVersion: 1,
          operations: Array.from({ length: 101 }, (_, index) => ({
            operationId: String(index),
            kind: "remove" as const,
            lineId: lineId(String(index)),
          })),
        },
        context,
      ),
    ).rejects.toThrow("between 1 and 100 operations");
  });
});
