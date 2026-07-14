import { describe, expect, it } from "vitest";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import {
  decideSavedList,
  evolveSavedList,
  initialSavedListState,
  toSavedListOwnerSnapshot,
  toSavedListViewerSnapshot,
  type SavedListCommand,
  type SavedListEvent,
} from "./domain";
import type { SavedListCommandId, SavedListId, SavedListLineId, SavedListState } from "./contracts";

const listId = "svl_test" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;
const createdAt = "2026-07-13T12:00:00.000Z";

function commandId(value: string) {
  return `slc_${value}` as SavedListCommandId;
}

function lineId(value: string) {
  return `sll_${value}` as SavedListLineId;
}

function product(value: string) {
  const catalogItemId = `cat_${value}` as CatalogItemId;
  return {
    catalogItemId,
    productId: `${catalogItemId}::condition:near-mint` as ProductKey,
    selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
  } as const;
}

function evolve(
  state: SavedListState,
  command: SavedListCommand,
): Readonly<{ state: SavedListState; events: readonly SavedListEvent[] }> {
  const events = decideSavedList(state, command);
  return { state: events.reduce(evolveSavedList, state), events };
}

function createdList() {
  return evolve(initialSavedListState, {
    type: "CreateSavedList",
    commandId: commandId("create"),
    listId,
    ownerAccountId,
    title: "  Trade targets  ",
    description: "  Cards to find at the show. ",
    createdAt,
  }).state;
}

describe("Saved List aggregate", () => {
  it("creates private, normalizes exact Product membership, and merges repeat adds into the stable line", () => {
    const created = createdList();
    expect(created).toMatchObject({
      identity: { listId, ownerAccountId },
      title: "Trade targets",
      description: "Cards to find at the show.",
      visibility: "private",
      lifecycle: "active",
    });

    const first = evolve(created, {
      type: "AddSavedListLine",
      commandId: commandId("add-one"),
      lineId: lineId("one"),
      product: {
        ...product("charizard"),
        selectedOptions: [{ dimensionId: " condition ", optionId: " near-mint " }],
      },
      trackedQuantity: 2,
      privateNotes: "  Binder copy only. ",
      privateTags: [" show ", "priority", "show"],
      changedAt: "2026-07-13T12:01:00.000Z",
    });

    expect(first.state.lines[0]).toMatchObject({
      lineId: lineId("one"),
      trackedQuantity: 2,
      privateNotes: "Binder copy only.",
      privateTags: ["priority", "show"],
      product: {
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
      },
    });

    const merged = evolve(first.state, {
      type: "AddSavedListLine",
      commandId: commandId("add-again"),
      lineId: lineId("ignored"),
      product: product("charizard"),
      trackedQuantity: 3,
      privateNotes: "This does not replace existing private metadata.",
      privateTags: ["other"],
      changedAt: "2026-07-13T12:02:00.000Z",
    });

    expect(merged.events).toEqual([
      expect.objectContaining({
        type: "collections.saved-list.line-changed",
        data: expect.objectContaining({ lineId: lineId("one"), trackedQuantity: 5, changeKind: "merged" }),
      }),
    ]);
    expect(merged.state.lines).toHaveLength(1);
    expect(merged.state.lines[0]).toMatchObject({
      lineId: lineId("one"),
      trackedQuantity: 5,
      privateNotes: "Binder copy only.",
      privateTags: ["priority", "show"],
    });
  });

  it("replays deterministic ordering and clears a cover when its line is removed", () => {
    let state = createdList();
    for (const value of ["one", "two", "three"]) {
      state = evolve(state, {
        type: "AddSavedListLine",
        commandId: commandId(`add-${value}`),
        lineId: lineId(value),
        product: product(value),
        trackedQuantity: 1,
        changedAt: `2026-07-13T12:0${value === "one" ? 1 : value === "two" ? 2 : 3}:00.000Z`,
      }).state;
    }
    state = evolve(state, {
      type: "ChangeSavedListCover",
      commandId: commandId("cover"),
      lineId: lineId("two"),
      changedAt: "2026-07-13T12:04:00.000Z",
    }).state;
    state = evolve(state, {
      type: "ReorderSavedListLine",
      commandId: commandId("reorder"),
      lineId: lineId("three"),
      afterLineId: null,
      changedAt: "2026-07-13T12:05:00.000Z",
    }).state;

    expect(state.lines.map((line) => line.lineId)).toEqual([lineId("three"), lineId("one"), lineId("two")]);
    expect(state.cover).toEqual({ lineId: lineId("two") });

    state = evolve(state, {
      type: "RemoveSavedListLine",
      commandId: commandId("remove"),
      lineId: lineId("two"),
      changedAt: "2026-07-13T12:06:00.000Z",
    }).state;
    expect(state.cover).toBeNull();
    expect(state.lines.map((line) => line.lineId)).toEqual([lineId("three"), lineId("one")]);
  });

  it("keeps archived lists closed and enforces quantity and Product-selection invariants", () => {
    const state = createdList();
    expect(() =>
      decideSavedList(state, {
        type: "AddSavedListLine",
        commandId: commandId("bad-product"),
        lineId: lineId("bad"),
        product: {
          ...product("one"),
          productId: "cat_other::condition:near-mint" as ProductKey,
        },
        trackedQuantity: 1,
        changedAt: createdAt,
      }),
    ).toThrow("must belong to its Catalog Item");
    expect(() =>
      decideSavedList(state, {
        type: "AddSavedListLine",
        commandId: commandId("bad-quantity"),
        lineId: lineId("bad"),
        product: product("one"),
        trackedQuantity: 0,
        changedAt: createdAt,
      }),
    ).toThrow("positive whole number");

    const archived = evolve(state, {
      type: "ArchiveSavedList",
      commandId: commandId("archive"),
      archivedAt: "2026-07-13T13:00:00.000Z",
    }).state;
    expect(() =>
      decideSavedList(archived, {
        type: "ChangeSavedListVisibility",
        commandId: commandId("make-public"),
        visibility: "public",
        changedAt: "2026-07-13T13:01:00.000Z",
      }),
    ).toThrow("Archived Saved Lists cannot be changed");
  });

  it("redacts private fields by construction and never introduces Inventory, cost, Listing, or profit truth", () => {
    let state = createdList();
    state = evolve(state, {
      type: "AddSavedListLine",
      commandId: commandId("add-private"),
      lineId: lineId("private"),
      product: product("private"),
      trackedQuantity: 4,
      privateNotes: "Do not share",
      privateTags: ["private"],
      changedAt: "2026-07-13T12:01:00.000Z",
    }).state;
    state = evolve(state, {
      type: "ChangeSavedListVisibility",
      commandId: commandId("public"),
      visibility: "public",
      changedAt: "2026-07-13T12:02:00.000Z",
    }).state;

    const owner = toSavedListOwnerSnapshot(state, 3);
    const hiddenQuantity = toSavedListViewerSnapshot(owner, { showTrackedQuantities: false });
    const shownQuantity = toSavedListViewerSnapshot(owner, { showTrackedQuantities: true });
    expect(hiddenQuantity?.lines[0]).toEqual({
      lineId: lineId("private"),
      product: product("private"),
      trackedQuantity: null,
      position: 0,
    });
    expect(shownQuantity?.lines[0]?.trackedQuantity).toBe(4);
    expect(JSON.stringify(hiddenQuantity)).not.toMatch(/privateNotes|privateTags|Do not share/);
    expect(JSON.stringify(owner)).not.toMatch(
      /inventoryItemId|acquisitionCost|costBasis|locationId|sellerSku|hold|availability|askingPrice|listingId|profit|p&l/i,
    );
  });

  it("rebuilds the same authoritative state from the complete versioned event history", () => {
    const commands: SavedListCommand[] = [
      {
        type: "CreateSavedList",
        commandId: commandId("replay-create"),
        listId,
        ownerAccountId,
        title: "Replay list",
        createdAt,
      },
      {
        type: "AddSavedListLine",
        commandId: commandId("replay-add-one"),
        lineId: lineId("one"),
        product: product("one"),
        trackedQuantity: 2,
        changedAt: "2026-07-13T12:01:00.000Z",
      },
      {
        type: "AddSavedListLine",
        commandId: commandId("replay-add-two"),
        lineId: lineId("two"),
        product: product("two"),
        trackedQuantity: 1,
        changedAt: "2026-07-13T12:02:00.000Z",
      },
      {
        type: "ReorderSavedListLine",
        commandId: commandId("replay-reorder"),
        lineId: lineId("two"),
        afterLineId: null,
        changedAt: "2026-07-13T12:03:00.000Z",
      },
      {
        type: "ChangeSavedListVisibility",
        commandId: commandId("replay-public"),
        visibility: "public",
        changedAt: "2026-07-13T12:04:00.000Z",
      },
    ];
    const history: SavedListEvent[] = [];
    let live = initialSavedListState;
    for (const command of commands) {
      const events = decideSavedList(live, command);
      history.push(...events);
      live = events.reduce(evolveSavedList, live);
    }

    const replayed = history.reduce(evolveSavedList, initialSavedListState);
    expect(replayed).toEqual(live);
    expect(history.every((event) => event.data.eventSchemaVersion === 1)).toBe(true);
    expect(toSavedListOwnerSnapshot(replayed, history.length).membership).toEqual({
      orderedLineIds: [lineId("two"), lineId("one")],
      lineCount: 2,
      trackedUnitCount: 3,
    });
  });

  it("enforces the 10,000-line aggregate bound without accepting an extra Product", () => {
    const base = createdList();
    const full: SavedListState = {
      ...base,
      lines: Array.from({ length: 10_000 }, (_, index) => ({
        lineId: lineId(String(index)),
        product: product(String(index)),
        trackedQuantity: 1,
        privateNotes: null,
        privateTags: [],
        addedAt: createdAt,
        changedAt: createdAt,
      })),
    };

    expect(() =>
      decideSavedList(full, {
        type: "AddSavedListLine",
        commandId: commandId("overflow"),
        lineId: lineId("overflow"),
        product: product("overflow"),
        trackedQuantity: 1,
        changedAt: createdAt,
      }),
    ).toThrow("reached the supported line limit");
  });
});
