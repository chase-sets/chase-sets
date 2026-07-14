import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SavedListId, SavedListLineId, SavedListOwnerSnapshot } from "../../features/saved-lists/domain";
import { CollectionOverviewSection } from "./collection-overview-section";
import { OwnedCardsSection } from "./owned-cards-section";
import { SavedListsSection } from "./saved-lists-section";
import { MyCollectionPage } from "./my-collection-page";
import type {
  CollectionOverviewView,
  MyCollectionHrefs,
  MyCollectionView,
  OwnedCardsView,
  SavedListDetailView,
  SavedListSummaryView,
  SavedListsView,
} from "./view-models";

const brand = <T,>(value: string): T => value as unknown as T;

const hrefs: MyCollectionHrefs = {
  section: (section) => `/account/collection?section=${section}`,
  list: (listId) => `/account/collection/lists/${listId}`,
  lists: "/account/collection?section=lists",
};

function readyOverview(overrides: Partial<CollectionOverviewView> = {}): CollectionOverviewView {
  return {
    status: "ready",
    pricingDegraded: false,
    totalValue: { amount: "1234.50", currency: "USD" },
    ownedCardCount: 12,
    ownedUnitCount: 40,
    savedListCount: 3,
    pricedCoveragePercent: 92,
    recentActivity: [
      { id: "a1", kind: "list-created", subject: "Chase Binder", occurredAt: "2026-07-01T00:00:00.000Z" },
    ],
    ...overrides,
  };
}

function ownedCards(overrides: Partial<OwnedCardsView> = {}): OwnedCardsView {
  return {
    status: "ready",
    pricingDegraded: false,
    showAcquisitionCost: true,
    cards: [
      {
        itemId: "inv_1",
        title: "Charizard",
        subtitle: "Base Set",
        productSummary: "Condition: Raw",
        ownedQuantity: 3,
        availableQuantity: 2,
        heldQuantity: 1,
        acquisitionCost: { amount: "50.00", currency: "USD" },
        marketValue: { amount: "220.00", currency: "USD" },
        manageHref: "/account/inventory/items/inv_1",
      },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SavedListOwnerSnapshot> = {}): SavedListOwnerSnapshot {
  return {
    contractVersion: 1,
    identity: { listId: brand<SavedListId>("svl_1"), ownerAccountId: brand("acc_1") },
    title: "Chase Binder",
    description: "Cards I want",
    visibility: "private",
    lifecycle: "active",
    cover: null,
    membership: {
      orderedLineIds: [brand<SavedListLineId>("sll_1")],
      lineCount: 1,
      trackedUnitCount: 4,
    },
    lines: [
      {
        lineId: brand<SavedListLineId>("sll_1"),
        product: {
          catalogItemId: brand("cat_1"),
          productId: brand("cat_1::raw"),
          selectedOptions: [],
        },
        trackedQuantity: 4,
        privateNotes: "grail",
        privateTags: ["want", "psa10"],
        addedAt: "2026-07-01T00:00:00.000Z",
        changedAt: "2026-07-02T00:00:00.000Z",
        position: 0,
      },
    ],
    createdAt: "2026-07-01T00:00:00.000Z",
    changedAt: "2026-07-02T00:00:00.000Z",
    archivedAt: null,
    version: 5,
    ...overrides,
  };
}

function summary(): SavedListSummaryView {
  return {
    listId: brand<SavedListId>("svl_1"),
    title: "Chase Binder",
    description: "Cards I want",
    visibility: "private",
    lineCount: 1,
    trackedUnitCount: 4,
    changedAt: "2026-07-02T00:00:00.000Z",
    estimatedValue: { amount: "300.00", currency: "USD" },
  };
}

function detailView(overrides: Partial<SavedListDetailView> = {}): SavedListDetailView {
  return {
    snapshot: snapshot(),
    estimatedValue: { amount: "300.00", currency: "USD" },
    lineDisplay: {
      [brand<SavedListLineId>("sll_1")]: {
        title: "Charizard",
        subtitle: "Base Set",
        availability: "active",
        estimatedValue: { amount: "220.00", currency: "USD" },
      },
    },
    ...overrides,
  };
}

describe("My Collection overview section", () => {
  it("shows a single account-wide valuation total and priced coverage when ready", () => {
    const html = renderToString(<CollectionOverviewSection overview={readyOverview()} />);
    expect(html).toContain("$1,234.50");
    expect(html).toContain("92% priced");
  });

  it("degrades value without an error when pricing is unavailable", () => {
    const html = renderToString(
      <CollectionOverviewSection
        overview={readyOverview({ pricingDegraded: true, totalValue: null, pricedCoveragePercent: null })}
      />,
    );
    expect(html).toContain("Pricing is temporarily unavailable");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("$1,234.50");
  });

  it("renders empty and error states", () => {
    expect(renderToString(<CollectionOverviewSection overview={readyOverview({ status: "empty" })} />)).toContain(
      "Your collection is empty",
    );
    expect(renderToString(<CollectionOverviewSection overview={readyOverview({ status: "error" })} />)).toContain(
      "taking longer than expected",
    );
  });
});

describe("Owned Cards section", () => {
  it("labels owned quantities unambiguously and shows cost when visible", () => {
    const html = renderToString(<OwnedCardsSection ownedCards={ownedCards()} />);
    expect(html).toContain("Owned");
    expect(html).toContain("Available");
    expect(html).toContain("Held");
    expect(html).toContain("Acquisition cost");
    expect(html).toContain("$50.00");
    expect(html).toContain("Manage in Inventory");
  });

  it("hides cost basis when the actor cannot see cost", () => {
    const html = renderToString(<OwnedCardsSection ownedCards={ownedCards({ showAcquisitionCost: false })} />);
    expect(html).not.toContain("Acquisition cost");
  });

  it("degrades market value while keeping cards usable", () => {
    const degraded = ownedCards({
      pricingDegraded: true,
      cards: [{ ...ownedCards().cards[0], marketValue: null }],
    });
    const html = renderToString(<OwnedCardsSection ownedCards={degraded} />);
    expect(html).toContain("Charizard");
    expect(html).toContain("Unavailable");
  });

  it("renders empty and error states", () => {
    expect(renderToString(<OwnedCardsSection ownedCards={ownedCards({ status: "empty", cards: [] })} />)).toContain(
      "No owned cards yet",
    );
    expect(renderToString(<OwnedCardsSection ownedCards={ownedCards({ status: "error" })} />)).toContain(
      "taking longer than expected",
    );
  });
});

describe("Saved Lists section", () => {
  const baseLists: SavedListsView = {
    status: "ready",
    lists: [summary()],
    query: "",
    selected: null,
    editUnavailable: false,
  };

  it("renders the list index with create and search entry points", () => {
    const html = renderToString(<SavedListsSection lists={baseLists} hrefs={hrefs} />);
    expect(html).toContain("Create Saved List");
    expect(html).toContain("Search your Saved Lists");
    expect(html).toContain("Chase Binder");
    expect(html).toContain("List value: $300.00");
  });

  it("shows an empty state and a no-results state", () => {
    expect(renderToString(<SavedListsSection lists={{ ...baseLists, lists: [] }} hrefs={hrefs} />)).toContain(
      "No Saved Lists yet",
    );
    expect(
      renderToString(<SavedListsSection lists={{ ...baseLists, lists: [], query: "zzz" }} hrefs={hrefs} />),
    ).toContain("No Saved Lists match your search");
  });

  it("opens Saved List detail with tracked quantity, notes, and tags, and never shows a cost basis", () => {
    const html = renderToString(<SavedListsSection lists={{ ...baseLists, selected: detailView() }} hrefs={hrefs} />);
    expect(html).toContain("Tracked qty");
    expect(html).toContain("Notes");
    expect(html).toContain("Tags");
    expect(html).toContain("Add to list");
    expect(html).not.toContain("Acquisition cost");
  });

  it("degrades Saved List edits to read-only when the command service is unreachable", () => {
    const html = renderToString(
      <SavedListsSection lists={{ ...baseLists, selected: detailView(), editUnavailable: true }} hrefs={hrefs} />,
    );
    expect(html).toContain("List edits are paused");
    expect(html).toContain("disabled");
  });

  it("renders an empty-list detail state", () => {
    const empty = detailView({
      snapshot: snapshot({ lines: [], membership: { orderedLineIds: [], lineCount: 0, trackedUnitCount: 0 } }),
    });
    const html = renderToString(<SavedListsSection lists={{ ...baseLists, selected: empty }} hrefs={hrefs} />);
    expect(html).toContain("This list has no cards yet");
  });
});

describe("My Collection deep module", () => {
  it("presents one surface with all three sections as tabs", () => {
    const view: MyCollectionView = {
      activeSection: "overview",
      overview: readyOverview(),
      ownedCards: ownedCards(),
      lists: { status: "ready", lists: [summary()], query: "", selected: null, editUnavailable: false },
    };
    const html = renderToString(<MyCollectionPage view={view} hrefs={hrefs} />);
    expect(html).toContain("My Collection");
    expect(html).toContain("Overview");
    expect(html).toContain("Owned Cards");
    expect(html).toContain("Lists");
  });
});
