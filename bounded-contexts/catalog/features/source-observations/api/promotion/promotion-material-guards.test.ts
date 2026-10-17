import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { context } from "../seeding/runtime-test-harness";
import {
  buildPromotionMaterialGuards,
  promotionMaterialCategory,
  promotionProfileAuthorityLock,
} from "./promotion-material-guards";
import { createPromotionTargetExclusion } from "./promotion-target-exclusion";
import { promotionProductOptions, promotionTargetKeyIdentity } from "./promotion-target-identity";
import { locatePromotionReferenceStreams } from "./promotion-reference-locator";
import productFixture from "../__fixtures__/tcgplayer-pokemon-sealed-product/normal.json";
import { tcgplayerPokemonSealedProductSourceObservationMappingContract } from "../providers/tcgplayer/executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { requireCatalogItemPromotionObservation } from "../source-observation-promotion-execution";

describe("closed promotion material guards", () => {
  it("proves the shipped sealed-product mapper emits promotable Product selectedOptions", () => {
    const selectedOptions = [{ dimensionId: "dim_synthetic", optionId: "opt_synthetic" }];
    const result = normalizeCatalogProviderSourceObservation({
      contract: tcgplayerPokemonSealedProductSourceObservationMappingContract,
      payload: {
        ...productFixture,
        observationId: "synthetic-options-inventory",
        externalKey: "synthetic-options-inventory",
        sourceUrl: "https://synthetic.invalid/options",
        externalCatalogItemReferences: [],
        externalProductReferences: [{ providerKey: "synthetic", externalKey: "sku:synthetic", selectedOptions }],
      },
      observedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.observation).not.toBeNull();
    const normalized = requireCatalogItemPromotionObservation(
      result.observation!.normalized,
      result.observation!.providerKey,
    );
    expect(normalized.kind).toBe("pokemon-sealed-product");
    expect(normalized.externalProductReferences).toEqual([
      { providerKey: "synthetic", externalKey: "sku:synthetic", selectedOptions },
    ]);
  });
  it("emits only source, item (including empty and negative evidence), binding and read reference guards; profiles use SQL SHARE", () => {
    const versions = new Map([
      ["catalog.source-observation-A", 2],
      ["catalog.item-target", 0],
      ["catalog.item-unlinked", 4],
      ["catalog.item-inactive", 8],
      ["catalog.promotion-target-key", 1],
      ["catalog.reference-record-set", 3],
      ["catalog.reference-type-set", 2],
    ]);
    const guards = buildPromotionMaterialGuards(versions, context);
    expect(guards.map((entry) => entry.streamId)).toEqual([...versions.keys()].sort());
    expect(
      guards.every((entry) => entry.events.length === 0 && entry.expectedVersion === versions.get(entry.streamId)),
    ).toBe(true);
    expect(new Set(guards.map((entry) => promotionMaterialCategory(entry.streamId)))).toEqual(
      new Set(["source", "item", "binding", "reference-authority"]),
    );
    expect(promotionProfileAuthorityLock).toBe(
      "LOCK TABLE catalog_provider_integration_profile_versions IN SHARE MODE",
    );
  });

  it.each(["display-template", "alias", "blueprint", "category", "field", "profile-generation"])(
    "never accepts an unclosed %s stream",
    (kind) => {
      expect(() => buildPromotionMaterialGuards(new Map([[`catalog.${kind}-synthetic`, 0]]), context)).toThrow(
        "promotion-target-outside-material-set",
      );
    },
  );

  it("rediscoveries are bounded to two and never report a conflicting append as success", async () => {
    const { eventStore } = createInMemoryEventStore();
    let attempts = 0;
    const boundary = createPromotionTargetExclusion({
      eventStore,
      ready: async () => undefined,
      locate: async () => [],
      append: async () => {
        attempts++;
        throw createEventStoreError("concurrency_conflict", "synthetic competing writer");
      },
    });
    await expect(
      boundary.acquire({
        keys: [{ level: "item", providerKey: "synthetic", externalKey: "retry" }],
        additionalTargetIds: ["cat_candidate_retry"],
        context,
        validateAuthority: async () => undefined,
        selectTarget: async () => "cat_candidate_retry",
      }),
    ).rejects.toThrow("promotion-target-rediscovery-exhausted");
    expect(attempts).toBe(3);
    expect(await eventStore.readAll()).toEqual([]);
  });

  it("keeps Option order out of compatibility and reference identity", () => {
    const options = [
      { dimensionId: "dim_b", optionId: "opt_b" },
      { dimensionId: "dim_a", optionId: "opt_a" },
    ];
    expect(promotionProductOptions(options)).toEqual(promotionProductOptions([...options].reverse()));
    expect(promotionTargetKeyIdentity({ level: "product", providerKey: " SYNTHETIC ", externalKey: " Key " })).toBe(
      '["product","synthetic","key"]',
    );
  });

  it("requires a final short keyset page and retains the decisive 501st locator", async () => {
    const cursors: unknown[] = [];
    let call = 0;
    const streams = await locatePromotionReferenceStreams(
      {
        query: async <T>(_sql: string, values?: readonly unknown[]) => {
          cursors.push(values?.at(-1));
          const rows =
            call++ === 0
              ? Array.from({ length: 500 }, (_, i) => ({ stream_id: `catalog.item-${String(i).padStart(3, "0")}` }))
              : call === 2
                ? [{ stream_id: "catalog.item-500" }]
                : [];
          return { rows: rows as T[], rowCount: rows.length };
        },
      },
      { level: "item", providerKey: "synthetic", externalKey: "page" },
    );
    expect(streams).toHaveLength(501);
    expect(cursors).toEqual(["", "catalog.item-499", ""]);
  });
});
