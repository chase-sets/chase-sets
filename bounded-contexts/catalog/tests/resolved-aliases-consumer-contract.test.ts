import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
  type ItemAliasesResolvedData,
} from "../features/catalog-items/domain/domain";
import {
  decideReferenceRecord,
  evolveReferenceRecord,
  initialReferenceRecordState,
  type ReferenceRecordAliasesResolvedData,
  type ReferenceRecordEvent,
} from "../features/reference-data/domain/domain";

// ---------------------------------------------------------------------------
// Resolved Alias consumer contract (#1910)
//
// Mirrors display-identity-consumer-contract.test.ts. The published alias fact
// is the only thing downstream search (#1911) and display (#1914) consume, so
// this test pins the canonical declaration site, the event names, the required
// fact fields, and the deploy-skew guarantee that existing consumers keep
// working before they subscribe.
// ---------------------------------------------------------------------------

const ITEM_ALIASES_RESOLVED_EVENT = "catalog.catalog-item.aliases-resolved";
const REFERENCE_RECORD_ALIASES_RESOLVED_EVENT = "catalog.reference-record.aliases-resolved";

describe("resolved alias fact declaration site and shape", () => {
  it("declares catalog.catalog-item.aliases-resolved on the Catalog Item aggregate", () => {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: "cat_1" as never,
      title: { defaultLocale: "en", values: { en: "Charizard" } } as never,
    });
    const stateAfterCreate = created.reduce(evolveCatalogItem, initialCatalogItemState);

    const events = decideCatalogItem(stateAfterCreate, {
      type: "RecordCatalogItemAliases",
      catalogItemId: "cat_1" as never,
      aliasLanguageCode: "fr",
      aliases: [
        {
          aliasHash: "hash-1",
          aliasText: "Dracaufeu",
          normalizedAliasText: "dracaufeu",
          aliasType: "official-equivalent",
          confidence: "high",
          broad: false,
          providerKey: "tcgdex",
          sourceCategory: "provider-same-id-localized-endpoint",
        },
      ],
      resolvedAliasHash: "resolved-hash-1",
      resolverVersion: 1,
      resolvedAt: "2026-06-16T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    const event = events[0] as Extract<CatalogItemEvent, { type: typeof ITEM_ALIASES_RESOLVED_EVENT }>;
    expect(event.type).toBe(ITEM_ALIASES_RESOLVED_EVENT);

    // The published fact carries everything a downstream consumer needs without
    // reading alias candidates, provider profiles, or the review state machine.
    const data: ItemAliasesResolvedData = event.data;
    expect(data).toMatchObject({
      catalogItemId: "cat_1",
      aliasLanguageCode: "fr",
      resolvedAliasHash: "resolved-hash-1",
      resolverVersion: 1,
      resolvedAt: "2026-06-16T00:00:00.000Z",
    });
    expect(data.aliases[0]).toEqual({
      aliasHash: "hash-1",
      aliasText: "Dracaufeu",
      normalizedAliasText: "dracaufeu",
      aliasType: "official-equivalent",
      confidence: "high",
      broad: false,
      providerKey: "tcgdex",
      sourceCategory: "provider-same-id-localized-endpoint",
    });
  });

  it("declares catalog.reference-record.aliases-resolved on the Reference Record aggregate", () => {
    const created = decideReferenceRecord(initialReferenceRecordState, {
      type: "CreateReferenceRecord",
      referenceRecordId: "ref_1" as never,
      typeKey: "expansion",
      key: "triplet-beat",
      name: { defaultLocale: "en", values: { en: "Triplet Beat" } } as never,
    });
    const stateAfterCreate = created.reduce(evolveReferenceRecord, initialReferenceRecordState);

    const events = decideReferenceRecord(stateAfterCreate, {
      type: "RecordReferenceRecordAliases",
      referenceRecordId: "ref_1" as never,
      aliasLanguageCode: "ja",
      aliases: [
        {
          aliasHash: "hash-set-1",
          aliasText: "トリプレットビート",
          normalizedAliasText: "トリプレットビート",
          aliasType: "set-equivalent",
          confidence: "exact",
          broad: false,
          providerKey: "tcgdex",
          sourceCategory: "provider-same-id-localized-endpoint",
        },
      ],
      resolvedAliasHash: "resolved-hash-2",
      resolverVersion: 1,
      resolvedAt: "2026-06-16T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    const event = events[0] as Extract<ReferenceRecordEvent, { type: typeof REFERENCE_RECORD_ALIASES_RESOLVED_EVENT }>;
    expect(event.type).toBe(REFERENCE_RECORD_ALIASES_RESOLVED_EVENT);

    const data: ReferenceRecordAliasesResolvedData = event.data;
    expect(data).toMatchObject({
      referenceRecordId: "ref_1",
      aliasLanguageCode: "ja",
      resolvedAliasHash: "resolved-hash-2",
      resolverVersion: 1,
    });
    expect(data.aliases[0]?.aliasType).toBe("set-equivalent");
  });

  it("the recompute leaves aggregate state unchanged (the fact is a derived publication, not a state mutation)", () => {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: "cat_1" as never,
      title: { defaultLocale: "en", values: { en: "Charizard" } } as never,
    });
    const stateAfterCreate = created.reduce(evolveCatalogItem, initialCatalogItemState);
    const event: CatalogItemEvent = {
      type: ITEM_ALIASES_RESOLVED_EVENT,
      data: {
        catalogItemId: "cat_1" as never,
        aliasLanguageCode: "en",
        aliases: [],
        resolvedAliasHash: "h",
        resolverVersion: 1,
        resolvedAt: "2026-06-16T00:00:00.000Z",
      },
    } as never;
    expect(evolveCatalogItem(stateAfterCreate, event)).toEqual(stateAfterCreate);
  });

  it("lists the resolved alias fact in the catalog README integration surface", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(ITEM_ALIASES_RESOLVED_EVENT);
    expect(readme).toContain(REFERENCE_RECORD_ALIASES_RESOLVED_EVENT);
  });

  it("keeps existing consumers working before they subscribe (deploy-skew safety)", () => {
    // Subscription versioning + deploy skew: existing Discovery projections must
    // not reference the new alias events until #1911 / #1914 bump their
    // subscriptionVersion. Adding the alias events to a subscription before its
    // consumer code handles them would replay unknown events. This test fails if
    // a future edit subscribes a projection to the alias facts without bumping
    // the version, surfacing the deploy-skew checklist.
    const discovery = JSON.parse(readFileSync(new URL("../../discovery/context.json", import.meta.url), "utf8")) as {
      eventSubscriptions: Array<{ subscriptionVersion: number; eventTypes: string[] }>;
    };
    for (const subscription of discovery.eventSubscriptions) {
      if (
        subscription.eventTypes.includes(ITEM_ALIASES_RESOLVED_EVENT) ||
        subscription.eventTypes.includes(REFERENCE_RECORD_ALIASES_RESOLVED_EVENT)
      ) {
        // If a consumer subscribes, it must declare a versioned subscription so
        // deploy skew is intentional and tracked.
        expect(subscription.subscriptionVersion).toBeGreaterThanOrEqual(1);
      }
    }
    // Until #1911 / #1914 land, no Discovery subscription consumes the alias
    // facts, so existing consumers continue on their current subscription.
    const subscribesToAliasFacts = discovery.eventSubscriptions.some(
      (subscription) =>
        subscription.eventTypes.includes(ITEM_ALIASES_RESOLVED_EVENT) ||
        subscription.eventTypes.includes(REFERENCE_RECORD_ALIASES_RESOLVED_EVENT),
    );
    expect(subscribesToAliasFacts).toBe(false);
  });
});
