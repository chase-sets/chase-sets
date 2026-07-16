import { describe, it, expect } from "vitest";
import { decideCatalogItem, evolveCatalogItem, initialCatalogItemState, type CatalogItemEvent } from "./domain";
import type { CatalogItemId, BlueprintId, FieldId, CategoryId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";

const itemId = "cat_test_item" as CatalogItemId;
const bpId = "bpr_test" as BlueprintId;
const fieldA = "fld_a" as FieldId;
const fieldB = "fld_b" as FieldId;
const catA = "ctg_a" as CategoryId;
const catB = "ctg_b" as CategoryId;

function l10n(en: string, values: Record<string, string> = {}) {
  return {
    defaultLocale: "en" as const,
    values: {
      en,
      ...values,
    },
  };
}

function createdState() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    {
      type: "catalog.catalog-item.created",
      data: { itemId, languageCode: "en", title: l10n("Test Card"), subtitle: null, description: l10n("") },
    },
  ] as CatalogItemEvent[]);
}

function draftWithBlueprint() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    {
      type: "catalog.catalog-item.created",
      data: { itemId, languageCode: "en", title: l10n("Test Card"), subtitle: null, description: l10n("") },
    },
    { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
    { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
  ] as CatalogItemEvent[]);
}

function activeState() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    {
      type: "catalog.catalog-item.created",
      data: { itemId, languageCode: "en", title: l10n("Test Card"), subtitle: null, description: l10n("") },
    },
    { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
    { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
    { type: "catalog.catalog-item.published", data: { blueprintId: bpId } },
  ] as CatalogItemEvent[]);
}

describe("CatalogItem aggregate", () => {
  describe("decideCatalogItem", () => {
    it("creates an item", () => {
      const events = decide(decideCatalogItem, initialCatalogItemState, {
        type: "CreateCatalogItem" as const,
        itemId,
        languageCode: "ja",
        title: l10n("Test Card", { ja: "テストカード" }),
        subtitle: l10n("Subtitle"),
      });

      expect(events[0].type).toBe("catalog.catalog-item.created");
      expect(events[0].data).toMatchObject({ itemId, languageCode: "ja" });
      expect(events[0]).toMatchObject({
        data: {
          title: { values: { en: "Test Card", ja: "テストカード" } },
          subtitle: { values: { en: "Subtitle" } },
        },
      });
    });

    it("rejects non-BCP Japanese language code", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, initialCatalogItemState, {
            type: "CreateCatalogItem" as const,
            itemId,
            languageCode: "jp",
            title: l10n("Test Card"),
          }),
        'Use the BCP 47 language code "ja" for Japanese.',
      );
    });

    it("requires an English title", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, initialCatalogItemState, {
            type: "CreateCatalogItem" as const,
            itemId,
            title: { defaultLocale: "en", values: { ja: "テストカード" } },
          }),
        "Catalog items require an English title.",
      );
    });

    it("rejects creating twice", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), {
            type: "CreateCatalogItem" as const,
            itemId: "other" as CatalogItemId,
            title: l10n("X"),
          }),
        "Catalog item has already been created.",
      );
    });

    it("assigns a blueprint while draft", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "AssignBlueprintToCatalogItem" as const,
        blueprintId: bpId,
      });

      expect(events[0].type).toBe("catalog.catalog-item.blueprint-assigned");
    });

    it("rejects blueprint assignment after publish", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, activeState(), {
            type: "AssignBlueprintToCatalogItem" as const,
            blueprintId: "bpr_other" as BlueprintId,
          }),
        "Blueprint may only be assigned while draft.",
      );
    });

    it("sets a field value", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "SetCatalogItemFieldValue" as const,
        fieldId: fieldA,
        value: "Red",
      });

      expect(events[0].type).toBe("catalog.catalog-item.field-value-set");
    });

    it("links and unlinks external product references", () => {
      const linkedEvents = decide(decideCatalogItem, createdState(), {
        type: "LinkExternalProductReference" as const,
        providerKey: "TCGplayer",
        externalKey: " SKU-1 ",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      });
      const linkedState = givenEvents(createdState(), evolveCatalogItem, linkedEvents as CatalogItemEvent[]);
      const unlinkedEvents = decide(decideCatalogItem, linkedState, {
        type: "UnlinkExternalProductReference" as const,
        providerKey: "tcgplayer",
        externalKey: "sku-1",
      });

      expect(linkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.external-product-reference-linked",
        data: {
          providerKey: "tcgplayer",
          externalKey: "sku-1",
        },
      });
      expect(unlinkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.external-product-reference-unlinked",
        data: {
          providerKey: "tcgplayer",
          externalKey: "sku-1",
        },
      });
    });

    it("links and unlinks external catalog item references separately from product references", () => {
      const linkedEvents = decide(decideCatalogItem, createdState(), {
        type: "LinkExternalCatalogItemReference" as const,
        providerKey: "TCGplayer",
        externalKey: " product:12345 ",
      });
      const linkedState = givenEvents(createdState(), evolveCatalogItem, linkedEvents as CatalogItemEvent[]);
      const unlinkedEvents = decide(decideCatalogItem, linkedState, {
        type: "UnlinkExternalCatalogItemReference" as const,
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      });

      expect(linkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.external-catalog-item-reference-linked",
        data: {
          providerKey: "tcgplayer",
          externalKey: "product:12345",
        },
      });
      expect(unlinkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.external-catalog-item-reference-unlinked",
        data: {
          providerKey: "tcgplayer",
          externalKey: "product:12345",
        },
      });
    });

    it("links and unlinks a GTIN, normalizing it to canonical GTIN-14 form", () => {
      const linkedEvents = decide(decideCatalogItem, createdState(), {
        type: "LinkCatalogItemGtin" as const,
        gtin: "307418529636",
        productForm: " booster-box ",
      });
      const linkedState = givenEvents(createdState(), evolveCatalogItem, linkedEvents as CatalogItemEvent[]);
      const unlinkedEvents = decide(decideCatalogItem, linkedState, {
        type: "UnlinkCatalogItemGtin" as const,
        gtin: "307418529636",
      });

      expect(linkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.gtin-linked",
        data: {
          gtin: "00307418529636",
          productForm: "booster-box",
        },
      });
      expect(linkedState.gtins).toEqual([{ gtin: "00307418529636", productForm: "booster-box" }]);
      expect(unlinkedEvents[0]).toMatchObject({
        type: "catalog.catalog-item.gtin-unlinked",
        data: { gtin: "00307418529636" },
      });
    });

    it("rejects linking a GTIN with an invalid check digit", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), {
            type: "LinkCatalogItemGtin" as const,
            gtin: "307418529637",
          }),
        "GTIN must be a valid GTIN-8, GTIN-12, GTIN-13, or GTIN-14 barcode.",
      );
    });

    it("rejects unlinking a GTIN that is not linked to the item", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), {
            type: "UnlinkCatalogItemGtin" as const,
            gtin: "307418529636",
          }),
        "GTIN is not linked to this item.",
      );
    });

    it("clears a field value", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
      ] as CatalogItemEvent[]);

      const events = decide(decideCatalogItem, state, { type: "ClearCatalogItemFieldValue" as const, fieldId: fieldA });

      expect(events[0].type).toBe("catalog.catalog-item.field-value-cleared");
    });

    it("sets and clears an item image fallback", () => {
      const setEvents = decide(decideCatalogItem, createdState(), {
        type: "SetCatalogItemImageFallback" as const,
        imageFallback: {
          url: " https://assets.example/pokemon-back.webp ",
          alt: " Pokemon card back ",
          usage: "permanent",
          variants: {
            card: {
              oneX: " https://assets.example/pokemon-back-card.webp ",
              twoX: "https://assets.example/pokemon-back-card@2x.webp",
            },
          },
        },
      });
      const withFallback = givenEvents(createdState(), evolveCatalogItem, setEvents as CatalogItemEvent[]);
      const clearEvents = decide(decideCatalogItem, withFallback, {
        type: "ClearCatalogItemImageFallback" as const,
      });

      expect(setEvents[0]).toMatchObject({
        type: "catalog.catalog-item.image-fallback-set",
        data: {
          imageFallback: {
            url: "https://assets.example/pokemon-back.webp",
            alt: "Pokemon card back",
            usage: "permanent",
          },
        },
      });
      expect(clearEvents[0].type).toBe("catalog.catalog-item.image-fallback-cleared");
    });

    it("rejects an item image fallback without alt text", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), {
            type: "SetCatalogItemImageFallback" as const,
            imageFallback: {
              url: "https://assets.example/pokemon-back.webp",
              alt: "",
              usage: "loading-only",
              variants: {},
            },
          }),
        "Catalog item image fallback requires alt text.",
      );
    });

    it("rejects clearing a non-existent field value", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), { type: "ClearCatalogItemFieldValue" as const, fieldId: fieldA }),
        "The item does not contain that field value.",
      );
    });

    it("assigns item to category", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "AssignCatalogItemToCategory" as const,
        categoryId: catA,
      });

      expect(events[0].type).toBe("catalog.catalog-item.category-assigned");
    });

    it("rejects duplicate category assignment", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catA } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () => decide(decideCatalogItem, state, { type: "AssignCatalogItemToCategory" as const, categoryId: catA }),
        "Item already belongs to that category.",
      );
    });

    it("publishes a draft item with all required fields", () => {
      const events = decide(decideCatalogItem, draftWithBlueprint(), {
        type: "PublishCatalogItem" as const,
        blueprintIsActive: true,
        requiredFieldIds: [fieldA],
      });

      expect(events[0].type).toBe("catalog.catalog-item.published");
    });

    it("rejects publish without blueprint", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, createdState(), {
            type: "PublishCatalogItem" as const,
            blueprintIsActive: true,
            requiredFieldIds: [],
          }),
        "Items require a blueprint before publish.",
      );
    });

    it("rejects publish when blueprint is not active", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () =>
          decide(decideCatalogItem, state, {
            type: "PublishCatalogItem" as const,
            blueprintIsActive: false,
            requiredFieldIds: [],
          }),
        "Items may only publish against active blueprints.",
      );
    });

    it("rejects publish when required fields are missing", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () =>
          decide(decideCatalogItem, state, {
            type: "PublishCatalogItem" as const,
            blueprintIsActive: true,
            requiredFieldIds: [fieldA],
          }),
        "Items must satisfy all required field rules before publish.",
      );
    });

    it("revises metadata on active item", () => {
      const events = decide(decideCatalogItem, activeState(), {
        type: "ReviseCatalogItemMetadata" as const,
        languageCode: "en",
        title: l10n("Updated Title"),
        subtitle: l10n("New Sub"),
      });

      expect(events[0].type).toBe("catalog.catalog-item.metadata-revised");
    });

    it("records a resolved display identity fact for downstream consumers", () => {
      const events = decide(decideCatalogItem, activeState(), {
        type: "RecordCatalogItemDisplayIdentity" as const,
        catalogItemId: itemId,
        languageCode: "en-US",
        title: " Test Card - Red ",
        subtitle: " Near Mint ",
        displayTemplateKey: " product-card-title ",
        displayTemplateTargetKind: "blueprint",
        displayTemplateTargetId: bpId,
        displayIdentityHash: " display-hash-1 ",
        resolverVersion: 1,
        resolvedAt: "2026-06-06T12:00:00.000Z",
        resolutionStatus: "resolved",
        missingTokens: [],
      });

      expect(events[0]).toMatchObject({
        type: "catalog.catalog-item.display-identity-resolved",
        data: {
          catalogItemId: itemId,
          languageCode: "en-US",
          title: "Test Card - Red",
          subtitle: "Near Mint",
          displayTemplateKey: "product-card-title",
          displayTemplateTargetKind: "blueprint",
          displayTemplateTargetId: bpId,
          displayIdentityHash: "display-hash-1",
          resolverVersion: 1,
          resolvedAt: "2026-06-06T12:00:00.000Z",
          resolutionStatus: "resolved",
          missingTokens: [],
        },
      });
    });

    it("records a degraded display identity fact carrying its missing tokens", () => {
      const events = decide(decideCatalogItem, activeState(), {
        type: "RecordCatalogItemDisplayIdentity" as const,
        catalogItemId: itemId,
        title: "Bare Title",
        displayIdentityHash: "display-hash-2",
        resolverVersion: 3,
        resolvedAt: "2026-06-06T12:00:00.000Z",
        resolutionStatus: "degraded",
        missingTokens: [" card-number ", "card-name", "card-name"],
      });

      expect(events[0]).toMatchObject({
        type: "catalog.catalog-item.display-identity-resolved",
        data: {
          catalogItemId: itemId,
          resolutionStatus: "degraded",
          // Trimmed, de-duplicated, and deterministically ordered.
          missingTokens: ["card-name", "card-number"],
        },
      });
    });

    it("treats a legacy display identity command without resolution status as resolved", () => {
      const events = decide(decideCatalogItem, activeState(), {
        type: "RecordCatalogItemDisplayIdentity" as const,
        catalogItemId: itemId,
        title: "Legacy",
        displayIdentityHash: "display-hash-3",
        resolverVersion: 1,
        resolvedAt: "2026-06-06T12:00:00.000Z",
      });

      expect(events[0]).toMatchObject({
        type: "catalog.catalog-item.display-identity-resolved",
        data: { resolutionStatus: "resolved", missingTokens: [] },
      });
    });

    it("requires resolved display identity to target the current item", () => {
      expectDomainError(
        () =>
          decide(decideCatalogItem, activeState(), {
            type: "RecordCatalogItemDisplayIdentity" as const,
            catalogItemId: "cat_other" as CatalogItemId,
            title: "Other",
            displayIdentityHash: "hash",
            resolverVersion: 1,
            resolvedAt: "2026-06-06T12:00:00.000Z",
          }),
        "Display identity must target the current Catalog Item.",
      );
    });

    it("lifecycle: active -> archived", () => {
      const archiveEvents = decide(decideCatalogItem, activeState(), { type: "ArchiveCatalogItem" as const });

      expect(archiveEvents[0].type).toBe("catalog.catalog-item.archived");
    });

    it("replays historical retired events as archived", () => {
      const state = givenEvents(activeState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.retired", data: {} },
      ] as CatalogItemEvent[]);

      expect(state.status).toBe("archived");
    });

    it("removes draft items", () => {
      const events = decide(decideCatalogItem, createdState(), { type: "RemoveDraftCatalogItem" as const });

      expect(events[0].type).toBe("catalog.catalog-item.draft-removed");
    });

    it("rejects removing active items", () => {
      expectDomainError(
        () => decide(decideCatalogItem, activeState(), { type: "RemoveDraftCatalogItem" as const }),
        "Only draft items can be removed.",
      );
    });

    it("rejects modifications to archived items", () => {
      const archivedState = givenEvents(activeState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.archived", data: {} },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () =>
          decide(decideCatalogItem, archivedState, {
            type: "SetCatalogItemFieldValue" as const,
            fieldId: fieldB,
            value: "x",
          }),
        "Archived items cannot be modified.",
      );
    });
  });

  describe("evolveCatalogItem", () => {
    it("evolves created event", () => {
      const state = evolveCatalogItem(initialCatalogItemState, {
        type: "catalog.catalog-item.created",
        data: { itemId, languageCode: "en", title: l10n("Test"), subtitle: l10n("Sub"), description: l10n("") },
      });

      expect(state.id).toBe(itemId);
      expect(state.title?.values.en).toBe("Test");
      expect(state.subtitle?.values.en).toBe("Sub");
      expect(state.status).toBe("draft");
    });

    it("evolves field value set replaces existing", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Blue" } },
      ] as CatalogItemEvent[]);

      expect(state.fieldValues).toHaveLength(1);
      expect(state.fieldValues[0].value).toBe("Blue");
    });

    it("evolves category assigned sorts alphabetically", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catB } },
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catA } },
      ] as CatalogItemEvent[]);

      expect(state.categoryIds).toEqual([catA, catB]);
    });

    it("evolves published event", () => {
      const state = evolveCatalogItem(draftWithBlueprint(), {
        type: "catalog.catalog-item.published",
        data: { blueprintId: bpId },
      });

      expect(state.status).toBe("active");
    });

    it("replays display identity resolved events without changing canonical item state", () => {
      const before = activeState();
      const after = evolveCatalogItem(before, {
        type: "catalog.catalog-item.display-identity-resolved",
        data: {
          catalogItemId: itemId,
          languageCode: "en",
          title: "Test Card - Red",
          subtitle: null,
          displayTemplateKey: "product-card-title",
          displayTemplateTargetKind: "blueprint",
          displayTemplateTargetId: bpId,
          displayIdentityHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-06-06T12:00:00.000Z",
        },
      });

      expect(after).toBe(before);
    });

    it("evolves draft removed event", () => {
      const state = evolveCatalogItem(createdState(), {
        type: "catalog.catalog-item.draft-removed",
        data: {},
      });

      expect(state.status).toBe("removed");
    });
  });
});
