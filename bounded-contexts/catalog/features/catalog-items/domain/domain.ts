import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeGtin } from "@chase-sets/primitives/gtin";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  ensureUniqueBy,
  localizedTextMapFromEnglish,
  normalizeLocaleCode,
  normalizeLocalizedTextMap,
  resolveLocalizedTextMap,
  type CatalogItemStatus,
  type CatalogValue,
  type EmptyEventData,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type { BlueprintId, CategoryId, FieldId, CatalogItemId } from "../../../ids";

export type ItemFieldValue = Readonly<{
  fieldId: FieldId;
  value: CatalogValue;
}>;

export type CatalogSelectedOptionReference = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type CatalogExternalProductReference = Readonly<{
  providerKey: string;
  externalKey: string;
  selectedOptions: readonly CatalogSelectedOptionReference[];
}>;

export type CatalogExternalCatalogItemReference = Readonly<{
  providerKey: string;
  externalKey: string;
}>;

/**
 * A GTIN-8/12/13/14 barcode linked to a Catalog Item, normalized to its
 * canonical 14-digit form. Unlike provider external references, a GTIN is
 * not scoped to any single provider -- it is the manufacturer's own
 * identifier, so it is unique across the whole Catalog. `productForm`
 * carries the sealed-product form (e.g. "booster-box") observed alongside
 * the barcode, so a lookup can distinguish sellable forms without a second
 * round trip.
 */
export type CatalogItemGtinLink = Readonly<{
  gtin: string;
  productForm: string | null;
}>;

export type CatalogItemImageFallbackUsage = "permanent" | "loading-only";

export type CatalogItemImageVariantDensity = Readonly<{
  oneX?: string;
  twoX?: string;
}>;

export type CatalogItemImageFallback = Readonly<{
  url: string;
  alt: string;
  usage: CatalogItemImageFallbackUsage;
  variants: Readonly<Record<string, CatalogItemImageVariantDensity>>;
}>;

export type CatalogItemState = Readonly<{
  id: CatalogItemId | null;
  languageCode: string;
  title: LocalizedTextMap | null;
  subtitle: LocalizedTextMap | null;
  description: LocalizedTextMap;
  blueprintId: BlueprintId | null;
  status: CatalogItemStatus;
  fieldValues: readonly ItemFieldValue[];
  categoryIds: readonly CategoryId[];
  tags: readonly string[];
  imageUrls: readonly string[];
  productAssetSets: readonly ProductAssetSet[];
  imageFallback: CatalogItemImageFallback | null;
  externalCatalogItemReferences: readonly CatalogExternalCatalogItemReference[];
  externalProductReferences: readonly CatalogExternalProductReference[];
  gtins: readonly CatalogItemGtinLink[];
}>;

export const initialCatalogItemState: CatalogItemState = {
  id: null,
  languageCode: "en",
  title: null,
  subtitle: null,
  description: localizedTextMapFromEnglish(""),
  blueprintId: null,
  status: "draft",
  fieldValues: [],
  categoryIds: [],
  tags: [],
  imageUrls: [],
  productAssetSets: [],
  imageFallback: null,
  externalCatalogItemReferences: [],
  externalProductReferences: [],
  gtins: [],
};

export type CreateCatalogItemCommand = Readonly<{
  type: "CreateCatalogItem";
  itemId: CatalogItemId;
  languageCode?: string;
  title: LocalizedTextMap;
  subtitle?: LocalizedTextMap | null;
  description?: LocalizedTextMap;
}>;

export type AssignBlueprintToCatalogItemCommand = Readonly<{
  type: "AssignBlueprintToCatalogItem";
  blueprintId: BlueprintId;
}>;

export type SetCatalogItemFieldValueCommand = Readonly<{
  type: "SetCatalogItemFieldValue";
  fieldId: FieldId;
  value: CatalogValue;
}>;

export type ClearCatalogItemFieldValueCommand = Readonly<{
  type: "ClearCatalogItemFieldValue";
  fieldId: FieldId;
  requiredFieldIds?: readonly FieldId[];
}>;

export type AssignCatalogItemToCategoryCommand = Readonly<{
  type: "AssignCatalogItemToCategory";
  categoryId: CategoryId;
}>;

export type RemoveCatalogItemFromCategoryCommand = Readonly<{
  type: "RemoveCatalogItemFromCategory";
  categoryId: CategoryId;
}>;

export type PublishCatalogItemCommand = Readonly<{
  type: "PublishCatalogItem";
  blueprintIsActive: boolean;
  requiredFieldIds: readonly FieldId[];
}>;

export type ReviseCatalogItemMetadataCommand = Readonly<{
  type: "ReviseCatalogItemMetadata";
  languageCode?: string;
  title: LocalizedTextMap;
  subtitle?: LocalizedTextMap | null;
  description?: LocalizedTextMap;
}>;

/**
 * Whether the resolver produced a fully-templated display identity (`resolved`)
 * or fell back to bare metadata because no template matched or a non-optional
 * token was missing/empty (`degraded`). Persisted and published so a degraded
 * catalog is visible state rather than a silent fallback.
 */
export type CatalogItemDisplayResolutionStatus = "resolved" | "degraded";

export type RecordCatalogItemDisplayIdentityCommand = Readonly<{
  type: "RecordCatalogItemDisplayIdentity";
  catalogItemId: CatalogItemId;
  languageCode?: string;
  title: string;
  subtitle?: string | null;
  displayTemplateKey?: string | null;
  displayTemplateTargetKind?: string | null;
  displayTemplateTargetId?: string | null;
  displayIdentityHash: string;
  resolverVersion: number;
  resolvedAt: string;
  /** Resolver outcome; absent legacy commands are treated as `resolved`. */
  resolutionStatus?: CatalogItemDisplayResolutionStatus;
  /** Required tokens/fields left unsatisfied when degraded; empty when resolved. */
  missingTokens?: readonly string[];
}>;

/**
 * One resolved alias entry in a published Catalog Item alias fact. Carries the
 * matchable text plus the type/confidence/provenance summary a downstream search
 * or display consumer needs without reading alias candidates or provider
 * internals.
 */
export type CatalogItemResolvedAliasEntry = Readonly<{
  aliasHash: string;
  aliasText: string;
  normalizedAliasText: string;
  aliasType: string;
  confidence: string;
  /** True when this alias text resolves to many Catalog Items (broad/species). */
  broad: boolean;
  /** Provenance summary: the provider and source-governance category. */
  providerKey: string;
  sourceCategory: string;
}>;

export type RecordCatalogItemAliasesCommand = Readonly<{
  type: "RecordCatalogItemAliases";
  catalogItemId: CatalogItemId;
  aliasLanguageCode: string;
  aliases: readonly CatalogItemResolvedAliasEntry[];
  resolvedAliasHash: string;
  resolverVersion: number;
  resolvedAt: string;
}>;

export type SetCatalogItemTagsCommand = Readonly<{
  type: "SetCatalogItemTags";
  tags: readonly string[];
}>;

export type SetCatalogItemImageUrlsCommand = Readonly<{
  type: "SetCatalogItemImageUrls";
  imageUrls: readonly string[];
}>;

export type SetCatalogItemProductAssetSetsCommand = Readonly<{
  type: "SetCatalogItemProductAssetSets";
  productAssetSets: readonly ProductAssetSet[];
}>;

export type SetCatalogItemImageFallbackCommand = Readonly<{
  type: "SetCatalogItemImageFallback";
  imageFallback: CatalogItemImageFallback;
}>;

export type ClearCatalogItemImageFallbackCommand = Readonly<{
  type: "ClearCatalogItemImageFallback";
}>;

export type LinkExternalProductReferenceCommand = Readonly<{
  type: "LinkExternalProductReference";
  providerKey: string;
  externalKey: string;
  selectedOptions?: readonly CatalogSelectedOptionReference[];
}>;

export type LinkExternalCatalogItemReferenceCommand = Readonly<{
  type: "LinkExternalCatalogItemReference";
  providerKey: string;
  externalKey: string;
}>;

export type UnlinkExternalProductReferenceCommand = Readonly<{
  type: "UnlinkExternalProductReference";
  providerKey: string;
  externalKey: string;
}>;

export type UnlinkExternalCatalogItemReferenceCommand = Readonly<{
  type: "UnlinkExternalCatalogItemReference";
  providerKey: string;
  externalKey: string;
}>;

export type LinkCatalogItemGtinCommand = Readonly<{
  type: "LinkCatalogItemGtin";
  gtin: string;
  productForm?: string | null;
}>;

export type UnlinkCatalogItemGtinCommand = Readonly<{
  type: "UnlinkCatalogItemGtin";
  gtin: string;
}>;

export type ArchiveCatalogItemCommand = Readonly<{
  type: "ArchiveCatalogItem";
}>;

export type RemoveDraftCatalogItemCommand = Readonly<{
  type: "RemoveDraftCatalogItem";
}>;

export type CatalogItemCommand =
  | CreateCatalogItemCommand
  | AssignBlueprintToCatalogItemCommand
  | SetCatalogItemFieldValueCommand
  | ClearCatalogItemFieldValueCommand
  | AssignCatalogItemToCategoryCommand
  | RemoveCatalogItemFromCategoryCommand
  | PublishCatalogItemCommand
  | ReviseCatalogItemMetadataCommand
  | RecordCatalogItemDisplayIdentityCommand
  | RecordCatalogItemAliasesCommand
  | SetCatalogItemTagsCommand
  | SetCatalogItemImageUrlsCommand
  | SetCatalogItemProductAssetSetsCommand
  | SetCatalogItemImageFallbackCommand
  | ClearCatalogItemImageFallbackCommand
  | LinkExternalCatalogItemReferenceCommand
  | LinkExternalProductReferenceCommand
  | UnlinkExternalCatalogItemReferenceCommand
  | UnlinkExternalProductReferenceCommand
  | LinkCatalogItemGtinCommand
  | UnlinkCatalogItemGtinCommand
  | ArchiveCatalogItemCommand
  | RemoveDraftCatalogItemCommand;

type ItemMetadata = Readonly<{
  languageCode: string;
  title: LocalizedTextMap;
  subtitle: LocalizedTextMap | null;
  description: LocalizedTextMap;
}>;

export type ItemCreatedEvent = DomainEvent<
  "catalog.catalog-item.created",
  Readonly<{
    itemId: CatalogItemId;
  }> &
    ItemMetadata
>;

export type ItemBlueprintAssignedEvent = DomainEvent<
  "catalog.catalog-item.blueprint-assigned",
  Readonly<{
    blueprintId: BlueprintId;
  }>
>;

export type ItemFieldValueSetEvent = DomainEvent<"catalog.catalog-item.field-value-set", ItemFieldValue>;

export type ItemFieldValueClearedEvent = DomainEvent<
  "catalog.catalog-item.field-value-cleared",
  Readonly<{
    fieldId: FieldId;
  }>
>;

export type ItemCategoryAssignedEvent = DomainEvent<
  "catalog.catalog-item.category-assigned",
  Readonly<{
    categoryId: CategoryId;
  }>
>;

export type ItemCategoryRemovedEvent = DomainEvent<
  "catalog.catalog-item.category-removed",
  Readonly<{
    categoryId: CategoryId;
  }>
>;

export type ItemPublishedEvent = DomainEvent<
  "catalog.catalog-item.published",
  Readonly<{
    blueprintId: BlueprintId;
  }>
>;

export type ItemMetadataRevisedEvent = DomainEvent<"catalog.catalog-item.metadata-revised", ItemMetadata>;

export type ItemDisplayIdentityResolvedData = Readonly<{
  catalogItemId: CatalogItemId;
  languageCode: string;
  title: string;
  subtitle: string | null;
  displayTemplateKey: string | null;
  displayTemplateTargetKind: string | null;
  displayTemplateTargetId: string | null;
  displayIdentityHash: string;
  resolverVersion: number;
  resolvedAt: string;
  // Additive resolver-outcome fields. Optional so historical facts replayed
  // before this resolver version remain valid; new facts always carry them.
  resolutionStatus?: CatalogItemDisplayResolutionStatus;
  missingTokens?: readonly string[];
}>;

export type ItemDisplayIdentityResolvedEvent = DomainEvent<
  "catalog.catalog-item.display-identity-resolved",
  ItemDisplayIdentityResolvedData
>;

export type ItemAliasesResolvedData = Readonly<{
  catalogItemId: CatalogItemId;
  aliasLanguageCode: string;
  aliases: readonly CatalogItemResolvedAliasEntry[];
  resolvedAliasHash: string;
  resolverVersion: number;
  resolvedAt: string;
}>;

export type ItemAliasesResolvedEvent = DomainEvent<"catalog.catalog-item.aliases-resolved", ItemAliasesResolvedData>;

export type ItemTagsSetEvent = DomainEvent<
  "catalog.catalog-item.tags-set",
  Readonly<{
    tags: string[];
  }>
>;

export type ItemImageUrlsSetEvent = DomainEvent<
  "catalog.catalog-item.image-urls-set",
  Readonly<{
    imageUrls: string[];
  }>
>;

export type ItemProductAssetSetsSetEvent = DomainEvent<
  "catalog.catalog-item.product-asset-sets-set",
  Readonly<{
    productAssetSets: ProductAssetSet[];
  }>
>;

export type ItemImageFallbackSetEvent = DomainEvent<
  "catalog.catalog-item.image-fallback-set",
  Readonly<{
    imageFallback: CatalogItemImageFallback;
  }>
>;

export type ItemImageFallbackClearedEvent = DomainEvent<"catalog.catalog-item.image-fallback-cleared", EmptyEventData>;

export type ItemExternalProductReferenceLinkedEvent = DomainEvent<
  "catalog.catalog-item.external-product-reference-linked",
  CatalogExternalProductReference
>;

export type ItemExternalCatalogItemReferenceLinkedEvent = DomainEvent<
  "catalog.catalog-item.external-catalog-item-reference-linked",
  CatalogExternalCatalogItemReference
>;

export type ItemExternalProductReferenceUnlinkedEvent = DomainEvent<
  "catalog.catalog-item.external-product-reference-unlinked",
  Readonly<{
    providerKey: string;
    externalKey: string;
  }>
>;

export type ItemExternalCatalogItemReferenceUnlinkedEvent = DomainEvent<
  "catalog.catalog-item.external-catalog-item-reference-unlinked",
  CatalogExternalCatalogItemReference
>;

export type ItemGtinLinkedEvent = DomainEvent<"catalog.catalog-item.gtin-linked", CatalogItemGtinLink>;

export type ItemGtinUnlinkedEvent = DomainEvent<
  "catalog.catalog-item.gtin-unlinked",
  Readonly<{
    gtin: string;
  }>
>;

export type ItemRetiredEvent = DomainEvent<"catalog.catalog-item.retired", EmptyEventData>;

export type ItemArchivedEvent = DomainEvent<"catalog.catalog-item.archived", EmptyEventData>;

export type ItemDraftRemovedEvent = DomainEvent<"catalog.catalog-item.draft-removed", EmptyEventData>;

export type CatalogItemEvent =
  | ItemCreatedEvent
  | ItemBlueprintAssignedEvent
  | ItemFieldValueSetEvent
  | ItemFieldValueClearedEvent
  | ItemCategoryAssignedEvent
  | ItemCategoryRemovedEvent
  | ItemPublishedEvent
  | ItemMetadataRevisedEvent
  | ItemDisplayIdentityResolvedEvent
  | ItemAliasesResolvedEvent
  | ItemTagsSetEvent
  | ItemImageUrlsSetEvent
  | ItemProductAssetSetsSetEvent
  | ItemImageFallbackSetEvent
  | ItemImageFallbackClearedEvent
  | ItemExternalCatalogItemReferenceLinkedEvent
  | ItemExternalProductReferenceLinkedEvent
  | ItemExternalCatalogItemReferenceUnlinkedEvent
  | ItemExternalProductReferenceUnlinkedEvent
  | ItemGtinLinkedEvent
  | ItemGtinUnlinkedEvent
  | ItemRetiredEvent
  | ItemArchivedEvent
  | ItemDraftRemovedEvent;

export const decideCatalogItem: AggregateDecider<CatalogItemState, CatalogItemCommand, CatalogItemEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateCatalogItem":
      assert(state.id === null, "Catalog item has already been created.");

      assertLocalizedTitle(command.title);

      return [
        {
          type: "catalog.catalog-item.created",
          data: {
            itemId: command.itemId,
            languageCode: normalizeLanguageCode(command.languageCode),
            title: normalizeLocalizedTextMap(command.title, { requiredEnglish: true }),
            subtitle: command.subtitle ? normalizeLocalizedTextMap(command.subtitle) : null,
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : localizedTextMapFromEnglish(""),
          },
        },
      ];
    case "AssignBlueprintToCatalogItem":
      requireCreatedItem(state);
      assert(state.status === "draft", "Blueprint may only be assigned while draft.");

      return [
        {
          type: "catalog.catalog-item.blueprint-assigned",
          data: {
            blueprintId: command.blueprintId,
          },
        },
      ];
    case "SetCatalogItemFieldValue":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);

      return [
        {
          type: "catalog.catalog-item.field-value-set",
          data: {
            fieldId: command.fieldId,
            value: command.value,
          },
        },
      ];
    case "ClearCatalogItemFieldValue":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      assert(
        state.fieldValues.some((fieldValue) => fieldValue.fieldId === command.fieldId),
        "The item does not contain that field value.",
      );

      if (state.status === "active") {
        assert(
          command.requiredFieldIds !== undefined,
          "Active items require required field context to clear a field value.",
        );
        assert(
          !command.requiredFieldIds.includes(command.fieldId),
          "Required field values cannot be cleared from active items.",
        );
      }

      return [
        {
          type: "catalog.catalog-item.field-value-cleared",
          data: {
            fieldId: command.fieldId,
          },
        },
      ];
    case "AssignCatalogItemToCategory":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      assert(!state.categoryIds.includes(command.categoryId), "Item already belongs to that category.");

      return [
        {
          type: "catalog.catalog-item.category-assigned",
          data: {
            categoryId: command.categoryId,
          },
        },
      ];
    case "RemoveCatalogItemFromCategory":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      assert(state.categoryIds.includes(command.categoryId), "Item does not belong to that category.");

      return [
        {
          type: "catalog.catalog-item.category-removed",
          data: {
            categoryId: command.categoryId,
          },
        },
      ];
    case "PublishCatalogItem": {
      requireCreatedItem(state);
      assert(state.status === "draft", "Only draft items can be published.");
      assert(state.blueprintId !== null, "Items require a blueprint before publish.");
      assert(command.blueprintIsActive, "Items may only publish against active blueprints.");

      const requiredFieldIds = normalizeRequiredFieldIds(command.requiredFieldIds);
      const populatedFieldIds = new Set(state.fieldValues.map((fieldValue) => fieldValue.fieldId));

      for (const requiredFieldId of requiredFieldIds) {
        assert(populatedFieldIds.has(requiredFieldId), "Items must satisfy all required field rules before publish.");
      }

      return [
        {
          type: "catalog.catalog-item.published",
          data: {
            blueprintId: state.blueprintId,
          },
        },
      ];
    }
    case "ReviseCatalogItemMetadata":
      requireCreatedItem(state);
      assertCatalogItemCanBeRevised(state);
      assertLocalizedTitle(command.title);

      return [
        {
          type: "catalog.catalog-item.metadata-revised",
          data: {
            languageCode: normalizeLanguageCode(command.languageCode ?? state.languageCode),
            title: normalizeLocalizedTextMap(command.title, { requiredEnglish: true }),
            subtitle: command.subtitle ? normalizeLocalizedTextMap(command.subtitle) : null,
            description: command.description ? normalizeLocalizedTextMap(command.description) : state.description,
          },
        },
      ];
    case "RecordCatalogItemDisplayIdentity": {
      requireCreatedItem(state);
      assert(command.catalogItemId === state.id, "Display identity must target the current Catalog Item.");

      return [
        {
          type: "catalog.catalog-item.display-identity-resolved",
          data: normalizeDisplayIdentityResolvedData(command),
        },
      ];
    }
    case "RecordCatalogItemAliases": {
      requireCreatedItem(state);
      assert(command.catalogItemId === state.id, "Resolved aliases must target the current Catalog Item.");

      return [
        {
          type: "catalog.catalog-item.aliases-resolved",
          data: normalizeItemAliasesResolvedData(command),
        },
      ];
    }
    case "SetCatalogItemTags":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);

      return [
        {
          type: "catalog.catalog-item.tags-set",
          data: {
            tags: normalizeTags(command.tags),
          },
        },
      ];
    case "SetCatalogItemImageUrls":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);

      return [
        {
          type: "catalog.catalog-item.image-urls-set",
          data: {
            imageUrls: [...command.imageUrls],
          },
        },
      ];
    case "SetCatalogItemProductAssetSets":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);

      return [
        {
          type: "catalog.catalog-item.product-asset-sets-set",
          data: {
            productAssetSets: [...command.productAssetSets],
          },
        },
      ];
    case "SetCatalogItemImageFallback":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);

      return [
        {
          type: "catalog.catalog-item.image-fallback-set",
          data: {
            imageFallback: normalizeImageFallback(command.imageFallback),
          },
        },
      ];
    case "ClearCatalogItemImageFallback":
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      assert(state.imageFallback !== null, "Catalog item does not have an image fallback.");

      return [
        {
          type: "catalog.catalog-item.image-fallback-cleared",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "LinkExternalProductReference": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const reference = normalizeExternalProductReference({
        providerKey: command.providerKey,
        externalKey: command.externalKey,
        selectedOptions: command.selectedOptions ?? [],
      });

      return [
        {
          type: "catalog.catalog-item.external-product-reference-linked",
          data: reference,
        },
      ];
    }
    case "LinkExternalCatalogItemReference": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const reference = normalizeExternalCatalogItemReference(command);

      return [
        {
          type: "catalog.catalog-item.external-catalog-item-reference-linked",
          data: reference,
        },
      ];
    }
    case "UnlinkExternalProductReference": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const providerKey = normalizeExternalKey(command.providerKey);
      const externalKey = normalizeExternalKey(command.externalKey);
      assert(providerKey.length > 0, "External product references require a provider.");
      assert(externalKey.length > 0, "External product references require an external key.");
      assert(
        state.externalProductReferences.some(
          (reference) => reference.providerKey === providerKey && reference.externalKey === externalKey,
        ),
        "External product reference is not linked to this item.",
      );

      return [
        {
          type: "catalog.catalog-item.external-product-reference-unlinked",
          data: { providerKey, externalKey },
        },
      ];
    }
    case "UnlinkExternalCatalogItemReference": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const reference = normalizeExternalCatalogItemReference(command);
      assert(
        state.externalCatalogItemReferences.some(
          (existing) =>
            existing.providerKey === reference.providerKey && existing.externalKey === reference.externalKey,
        ),
        "External catalog item reference is not linked to this item.",
      );

      return [
        {
          type: "catalog.catalog-item.external-catalog-item-reference-unlinked",
          data: reference,
        },
      ];
    }
    case "LinkCatalogItemGtin": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const link = normalizeGtinLink(command);

      return [
        {
          type: "catalog.catalog-item.gtin-linked",
          data: link,
        },
      ];
    }
    case "UnlinkCatalogItemGtin": {
      requireCreatedItem(state);
      assertCatalogItemCanBeModified(state);
      const gtin = requireNormalizedGtin(command.gtin);
      assert(
        state.gtins.some((link) => link.gtin === gtin),
        "GTIN is not linked to this item.",
      );

      return [
        {
          type: "catalog.catalog-item.gtin-unlinked",
          data: { gtin },
        },
      ];
    }
    case "ArchiveCatalogItem":
      requireCreatedItem(state);
      assert(state.status === "active", "Only active items can be archived.");

      return [
        {
          type: "catalog.catalog-item.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "RemoveDraftCatalogItem":
      requireCreatedItem(state);
      assert(state.status === "draft", "Only draft items can be removed.");

      return [
        {
          type: "catalog.catalog-item.draft-removed",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCatalogItem: AggregateEvolver<CatalogItemState, CatalogItemEvent> = (state, event) => {
  switch (event.type) {
    case "catalog.catalog-item.created":
      return {
        ...state,
        id: event.data.itemId,
        languageCode: event.data.languageCode,
        title: event.data.title,
        subtitle: event.data.subtitle,
        description: event.data.description,
        status: "draft",
      };
    case "catalog.catalog-item.blueprint-assigned":
      return {
        ...state,
        blueprintId: event.data.blueprintId,
      };
    case "catalog.catalog-item.field-value-set":
      return {
        ...state,
        fieldValues: normalizeFieldValues([
          ...state.fieldValues.filter((fieldValue) => fieldValue.fieldId !== event.data.fieldId),
          event.data,
        ]),
      };
    case "catalog.catalog-item.field-value-cleared":
      return {
        ...state,
        fieldValues: state.fieldValues.filter((fieldValue) => fieldValue.fieldId !== event.data.fieldId),
      };
    case "catalog.catalog-item.category-assigned":
      return {
        ...state,
        categoryIds: [...state.categoryIds, event.data.categoryId].sort((left, right) => left.localeCompare(right)),
      };
    case "catalog.catalog-item.category-removed":
      return {
        ...state,
        categoryIds: state.categoryIds.filter((categoryId) => categoryId !== event.data.categoryId),
      };
    case "catalog.catalog-item.published":
      return {
        ...state,
        blueprintId: event.data.blueprintId,
        status: "active",
      };
    case "catalog.catalog-item.metadata-revised":
      return {
        ...state,
        languageCode: event.data.languageCode,
        title: event.data.title,
        subtitle: event.data.subtitle,
        description: event.data.description,
      };
    case "catalog.catalog-item.display-identity-resolved":
      return state;
    case "catalog.catalog-item.aliases-resolved":
      return state;
    case "catalog.catalog-item.tags-set":
      return {
        ...state,
        tags: event.data.tags,
      };
    case "catalog.catalog-item.image-urls-set":
      return {
        ...state,
        imageUrls: event.data.imageUrls,
      };
    case "catalog.catalog-item.product-asset-sets-set":
      return {
        ...state,
        productAssetSets: event.data.productAssetSets,
      };
    case "catalog.catalog-item.image-fallback-set":
      return {
        ...state,
        imageFallback: event.data.imageFallback,
      };
    case "catalog.catalog-item.image-fallback-cleared":
      return {
        ...state,
        imageFallback: null,
      };
    case "catalog.catalog-item.external-product-reference-linked":
      return {
        ...state,
        externalProductReferences: normalizeExternalProductReferences([
          ...state.externalProductReferences.filter(
            (reference) =>
              reference.providerKey !== event.data.providerKey || reference.externalKey !== event.data.externalKey,
          ),
          event.data,
        ]),
      };
    case "catalog.catalog-item.external-catalog-item-reference-linked":
      return {
        ...state,
        externalCatalogItemReferences: normalizeExternalCatalogItemReferences([
          ...state.externalCatalogItemReferences.filter(
            (reference) =>
              reference.providerKey !== event.data.providerKey || reference.externalKey !== event.data.externalKey,
          ),
          event.data,
        ]),
      };
    case "catalog.catalog-item.external-product-reference-unlinked":
      return {
        ...state,
        externalProductReferences: state.externalProductReferences.filter(
          (reference) =>
            reference.providerKey !== event.data.providerKey || reference.externalKey !== event.data.externalKey,
        ),
      };
    case "catalog.catalog-item.external-catalog-item-reference-unlinked":
      return {
        ...state,
        externalCatalogItemReferences: state.externalCatalogItemReferences.filter(
          (reference) =>
            reference.providerKey !== event.data.providerKey || reference.externalKey !== event.data.externalKey,
        ),
      };
    case "catalog.catalog-item.gtin-linked":
      return {
        ...state,
        gtins: normalizeGtinLinks([...state.gtins.filter((link) => link.gtin !== event.data.gtin), event.data]),
      };
    case "catalog.catalog-item.gtin-unlinked":
      return {
        ...state,
        gtins: state.gtins.filter((link) => link.gtin !== event.data.gtin),
      };
    case "catalog.catalog-item.retired":
      return {
        ...state,
        status: "archived",
      };
    case "catalog.catalog-item.archived":
      return {
        ...state,
        status: "archived",
      };
    case "catalog.catalog-item.draft-removed":
      return {
        ...state,
        status: "removed",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedItem(state: CatalogItemState): void {
  assert(state.id !== null, "Catalog item must be created first.");
}

function assertCatalogItemCanBeModified(state: CatalogItemState): void {
  assert(state.status !== "archived", "Archived items cannot be modified.");
  assert(state.status !== "removed", "Removed draft items cannot be modified.");
}

function assertCatalogItemCanBeRevised(state: CatalogItemState): void {
  assert(state.status !== "archived", "Archived items cannot be revised.");
  assert(state.status !== "removed", "Removed draft items cannot be revised.");
}

export function resolveCatalogItemTitle(item: Pick<CatalogItemState, "title">, locale = "en"): string {
  return resolveLocalizedTextMap(item.title, locale);
}

export function resolveCatalogItemSubtitle(item: Pick<CatalogItemState, "subtitle">, locale = "en"): string | null {
  const value = resolveLocalizedTextMap(item.subtitle, locale);
  return value.length > 0 ? value : null;
}

export function resolveCatalogItemDescription(item: Pick<CatalogItemState, "description">, locale = "en"): string {
  return resolveLocalizedTextMap(item.description, locale);
}

function normalizeLanguageCode(languageCode: string | undefined): string {
  return normalizeLocaleCode(languageCode ?? "en");
}

function assertLocalizedTitle(title: LocalizedTextMap): void {
  assert(title.values?.en?.trim().length > 0, "Catalog items require an English title.");
}

function normalizeDisplayIdentityResolvedData(
  command: RecordCatalogItemDisplayIdentityCommand,
): ItemDisplayIdentityResolvedData {
  const title = command.title.trim();
  const subtitle = command.subtitle?.trim() || null;
  const displayIdentityHash = command.displayIdentityHash.trim();
  const resolvedAt = command.resolvedAt.trim();

  assert(title.length > 0, "Resolved display identity requires a title.");
  assert(displayIdentityHash.length > 0, "Resolved display identity requires a hash.");
  assert(
    Number.isInteger(command.resolverVersion) && command.resolverVersion > 0,
    "Resolved display identity requires a positive resolver version.",
  );
  assert(!Number.isNaN(Date.parse(resolvedAt)), "Resolved display identity requires a valid resolved timestamp.");

  return {
    catalogItemId: command.catalogItemId,
    languageCode: normalizeLanguageCode(command.languageCode),
    title,
    subtitle,
    displayTemplateKey: normalizeNullableString(command.displayTemplateKey),
    displayTemplateTargetKind: normalizeNullableString(command.displayTemplateTargetKind),
    displayTemplateTargetId: normalizeNullableString(command.displayTemplateTargetId),
    displayIdentityHash,
    resolverVersion: command.resolverVersion,
    resolvedAt,
    resolutionStatus: normalizeResolutionStatus(command.resolutionStatus),
    missingTokens: normalizeMissingTokens(command.missingTokens),
  };
}

function normalizeResolutionStatus(
  value: CatalogItemDisplayResolutionStatus | undefined,
): CatalogItemDisplayResolutionStatus {
  // Legacy commands predate resolver-outcome tracking; treat them as resolved.
  if (value === undefined) {
    return "resolved";
  }

  assert(
    value === "resolved" || value === "degraded",
    "Resolved display identity resolution status must be resolved or degraded.",
  );
  return value;
}

function normalizeMissingTokens(tokens: readonly string[] | undefined): readonly string[] {
  const normalized = [...new Set((tokens ?? []).map((token) => token.trim()).filter((token) => token.length > 0))];
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeItemAliasesResolvedData(command: RecordCatalogItemAliasesCommand): ItemAliasesResolvedData {
  const aliasLanguageCode = normalizeLanguageCode(command.aliasLanguageCode);
  const resolvedAliasHash = command.resolvedAliasHash.trim();
  const resolvedAt = command.resolvedAt.trim();

  assert(resolvedAliasHash.length > 0, "Resolved aliases require a hash.");
  assert(
    Number.isInteger(command.resolverVersion) && command.resolverVersion > 0,
    "Resolved aliases require a positive resolver version.",
  );
  assert(!Number.isNaN(Date.parse(resolvedAt)), "Resolved aliases require a valid resolved timestamp.");

  return {
    catalogItemId: command.catalogItemId,
    aliasLanguageCode,
    aliases: normalizeResolvedAliasEntries(command.aliases),
    resolvedAliasHash,
    resolverVersion: command.resolverVersion,
    resolvedAt,
  };
}

function normalizeResolvedAliasEntries(
  aliases: readonly CatalogItemResolvedAliasEntry[],
): readonly CatalogItemResolvedAliasEntry[] {
  const normalized = aliases.map((alias) => ({
    aliasHash: alias.aliasHash.trim(),
    aliasText: alias.aliasText.trim(),
    normalizedAliasText: alias.normalizedAliasText.trim(),
    aliasType: alias.aliasType.trim(),
    confidence: alias.confidence.trim(),
    broad: alias.broad,
    providerKey: alias.providerKey.trim(),
    sourceCategory: alias.sourceCategory.trim(),
  }));

  for (const alias of normalized) {
    assert(alias.aliasHash.length > 0, "Resolved alias entries require an alias hash.");
    assert(alias.aliasText.length > 0, "Resolved alias entries require alias text.");
  }

  ensureUniqueBy(normalized, (alias) => alias.aliasHash, "Resolved aliases must be unique per alias hash.");

  // Deterministic ordering keeps the published fact and its hash stable
  // regardless of query order, so replay/backfill reproduce the same fact.
  return [...normalized].sort((left, right) =>
    left.normalizedAliasText === right.normalizedAliasText
      ? left.aliasHash.localeCompare(right.aliasHash)
      : left.normalizedAliasText.localeCompare(right.normalizedAliasText),
  );
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeFieldValues(fieldValues: readonly ItemFieldValue[]): readonly ItemFieldValue[] {
  ensureUniqueBy(fieldValues, (fieldValue) => fieldValue.fieldId, "Catalog items may only hold one value per field.");

  return [...fieldValues].sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeImageFallback(imageFallback: CatalogItemImageFallback): CatalogItemImageFallback {
  const url = imageFallback.url.trim();
  const alt = imageFallback.alt.trim();

  assert(url.length > 0, "Catalog item image fallback requires a URL.");
  assert(alt.length > 0, "Catalog item image fallback requires alt text.");
  assert(
    imageFallback.usage === "permanent" || imageFallback.usage === "loading-only",
    "Catalog item image fallback usage must be permanent or loading-only.",
  );

  return {
    url,
    alt,
    usage: imageFallback.usage,
    variants: normalizeImageFallbackVariants(imageFallback.variants),
  };
}

function normalizeImageFallbackVariants(
  variants: CatalogItemImageFallback["variants"] | undefined,
): CatalogItemImageFallback["variants"] {
  const entries = Object.entries(variants ?? {})
    .map(([size, density]) => {
      const oneX = density.oneX?.trim();
      const twoX = density.twoX?.trim();

      return [
        size.trim(),
        {
          ...(oneX ? { oneX } : {}),
          ...(twoX ? { twoX } : {}),
        },
      ] as const;
    })
    .filter(([size, density]) => size.length > 0 && (density.oneX || density.twoX))
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function normalizeExternalKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeExternalProductReference(
  reference: CatalogExternalProductReference,
): CatalogExternalProductReference {
  const providerKey = normalizeExternalKey(reference.providerKey);
  const externalKey = normalizeExternalKey(reference.externalKey);
  assert(providerKey.length > 0, "External product references require a provider.");
  assert(externalKey.length > 0, "External product references require an external key.");

  return {
    providerKey,
    externalKey,
    selectedOptions: normalizeSelectedOptions(reference.selectedOptions),
  };
}

function normalizeExternalCatalogItemReference(
  reference: CatalogExternalCatalogItemReference,
): CatalogExternalCatalogItemReference {
  const providerKey = normalizeExternalKey(reference.providerKey);
  const externalKey = normalizeExternalKey(reference.externalKey);
  assert(providerKey.length > 0, "External catalog item references require a provider.");
  assert(externalKey.length > 0, "External catalog item references require an external key.");

  return {
    providerKey,
    externalKey,
  };
}

function normalizeSelectedOptions(
  selectedOptions: readonly CatalogSelectedOptionReference[],
): CatalogSelectedOptionReference[] {
  const normalized = selectedOptions
    .map((entry) => ({
      dimensionId: entry.dimensionId.trim(),
      optionId: entry.optionId.trim(),
    }))
    .filter((entry) => entry.dimensionId.length > 0 && entry.optionId.length > 0)
    .sort((left, right) =>
      left.dimensionId === right.dimensionId
        ? left.optionId.localeCompare(right.optionId)
        : left.dimensionId.localeCompare(right.dimensionId),
    );

  ensureUniqueBy(
    normalized,
    (entry) => entry.dimensionId,
    "External product reference selected options must be unique per dimension.",
  );

  return normalized;
}

function normalizeExternalProductReferences(
  references: readonly CatalogExternalProductReference[],
): CatalogExternalProductReference[] {
  const normalized = references
    .map(normalizeExternalProductReference)
    .sort((left, right) =>
      left.providerKey === right.providerKey
        ? left.externalKey.localeCompare(right.externalKey)
        : left.providerKey.localeCompare(right.providerKey),
    );

  ensureUniqueBy(
    normalized,
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
    "External product references must be unique per provider and key.",
  );

  return normalized;
}

function normalizeExternalCatalogItemReferences(
  references: readonly CatalogExternalCatalogItemReference[],
): CatalogExternalCatalogItemReference[] {
  const normalized = references
    .map(normalizeExternalCatalogItemReference)
    .sort((left, right) =>
      left.providerKey === right.providerKey
        ? left.externalKey.localeCompare(right.externalKey)
        : left.providerKey.localeCompare(right.providerKey),
    );

  ensureUniqueBy(
    normalized,
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
    "External catalog item references must be unique per provider and key.",
  );

  return normalized;
}

function requireNormalizedGtin(gtin: string): string {
  const normalized = normalizeGtin(gtin);
  assert(normalized !== null, "GTIN must be a valid GTIN-8, GTIN-12, GTIN-13, or GTIN-14 barcode.");
  return normalized as string;
}

function normalizeGtinLink(command: LinkCatalogItemGtinCommand): CatalogItemGtinLink {
  return {
    gtin: requireNormalizedGtin(command.gtin),
    productForm: normalizeNullableString(command.productForm ?? null),
  };
}

function normalizeGtinLinks(links: readonly CatalogItemGtinLink[]): readonly CatalogItemGtinLink[] {
  const normalized = [...links].sort((left, right) => left.gtin.localeCompare(right.gtin));

  ensureUniqueBy(normalized, (link) => link.gtin, "GTINs must be unique per item.");

  return normalized;
}

function normalizeRequiredFieldIds(fieldIds: readonly FieldId[]): readonly FieldId[] {
  const normalized = [...new Set(fieldIds)].sort((left, right) => left.localeCompare(right));

  ensureUniqueBy(
    normalized.map((fieldId) => ({ fieldId })),
    (entry) => entry.fieldId,
    "Required field IDs must be unique.",
  );

  return normalized;
}
