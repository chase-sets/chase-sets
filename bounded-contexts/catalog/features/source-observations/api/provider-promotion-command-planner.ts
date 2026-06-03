import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import {
  productAssetSetCompatibilityImageUrls,
  type ProductAssetSet,
} from "../../../support/runtime-support/product-assets";
import type { SourceObservationNormalized, SourceObservationPokemonCardNormalized } from "../domain/domain";
import type { CatalogProviderIntegrationProfile } from "./provider-integration-profiles";

export type CatalogProviderPromotionMode = "create" | "refresh";

export type CatalogProviderPromotionResolvedCatalogMapping = Readonly<{
  blueprintId: BlueprintId;
  categoryId: CategoryId;
  fieldIds: Readonly<{
    cardNumber: FieldId;
    cardName: FieldId;
    expansion: FieldId;
    rarity: FieldId;
    cardVariant: FieldId;
    cardIllustrator: FieldId;
    releaseYear: FieldId;
  }>;
}>;

export type CatalogProviderPromotionPreflight =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "blocked";
      code: "ambiguous-duplicate-candidates" | "missing-catalog-item-target" | "runtime-preflight-failed";
      diagnosticText: string;
      candidateCatalogItemIds?: readonly CatalogItemId[];
    }>;

export type CatalogProviderPromotionCommandPlanDiagnostic = Readonly<{
  code:
    | "missing-promotion-capability"
    | "unsupported-observation-kind"
    | "unsupported-profile-mapping-kind"
    | CatalogProviderPromotionPreflightBlocked["code"];
  path: string;
  diagnosticText: string;
}>;

export type CatalogProviderPromotionCommandPlan = Readonly<{
  planKind: "catalog-item-promotion";
  providerKey: string;
  mappingKind: CatalogProviderIntegrationProfile["normalizedObservationMapping"]["kind"];
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  requiresReview: true;
  commands: readonly CatalogItemCommand[];
  review: Readonly<{
    normalizedKind: string;
    commandCount: number;
    catalogItemReferencesLinked: number;
    sourceProductReferencesLinked: number;
  }>;
}>;

export type CatalogProviderPromotionCommandPlanResult =
  | Readonly<{
      status: "planned";
      plan: CatalogProviderPromotionCommandPlan;
      diagnostics: readonly [];
    }>
  | Readonly<{
      status: "blocked";
      plan: null;
      diagnostics: readonly CatalogProviderPromotionCommandPlanDiagnostic[];
    }>;

type CatalogProviderPromotionPreflightBlocked = Extract<CatalogProviderPromotionPreflight, { status: "blocked" }>;

export function planCatalogProviderPromotionCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
  preflight?: CatalogProviderPromotionPreflight;
}): CatalogProviderPromotionCommandPlanResult {
  const diagnostics = promotionDiagnostics(input);
  if (diagnostics.length > 0) {
    return {
      status: "blocked",
      plan: null,
      diagnostics,
    };
  }

  const normalized = input.normalized as SourceObservationPokemonCardNormalized;
  const commands = pokemonCardCommands({
    ...input,
    normalized,
  });

  return {
    status: "planned",
    plan: {
      planKind: "catalog-item-promotion",
      providerKey: input.providerKey,
      mappingKind: input.profile.normalizedObservationMapping.kind,
      mode: input.mode,
      catalogItemId: input.catalogItemId,
      requiresReview: true,
      commands,
      review: {
        normalizedKind: normalized.kind,
        commandCount: commands.length,
        catalogItemReferencesLinked: uniqueExternalCatalogItemReferences(normalized.externalCatalogItemReferences ?? [])
          .length,
        sourceProductReferencesLinked: 1,
      },
    },
    diagnostics: [],
  };
}

function promotionDiagnostics(input: {
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationNormalized;
  preflight?: CatalogProviderPromotionPreflight;
}): CatalogProviderPromotionCommandPlanDiagnostic[] {
  const diagnostics: CatalogProviderPromotionCommandPlanDiagnostic[] = [];

  if (!input.profile.capabilities.includes("catalog-item-promotion")) {
    diagnostics.push({
      code: "missing-promotion-capability",
      path: "profile.capabilities",
      diagnosticText: `${input.profile.displayName} does not declare Catalog Item promotion capability.`,
    });
  }

  if (input.profile.normalizedObservationMapping.kind !== "pokemon-card") {
    diagnostics.push({
      code: "unsupported-profile-mapping-kind",
      path: "profile.normalizedObservationMapping.kind",
      diagnosticText: `Catalog promotion planning does not support profile kind '${input.profile.normalizedObservationMapping.kind}'.`,
    });
  }

  if (input.normalized.kind !== "pokemon-card") {
    diagnostics.push({
      code: "unsupported-observation-kind",
      path: "normalized.kind",
      diagnosticText: `Catalog promotion planning does not support normalized kind '${input.normalized.kind}'.`,
    });
  }

  if (input.preflight?.status === "blocked") {
    diagnostics.push({
      code: input.preflight.code,
      path: "preflight",
      diagnosticText: input.preflight.diagnosticText,
    });
  }

  return diagnostics;
}

function pokemonCardCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationPokemonCardNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [];
  const imageUrls = input.productAssetSet
    ? productAssetSetCompatibilityImageUrls(input.productAssetSet)
    : [...input.normalized.imageUrls];

  if (input.mode === "create") {
    commands.push({
      type: "CreateCatalogItem",
      itemId: input.catalogItemId,
      languageCode: input.normalized.languageCode,
      title: localizedText(input.metadata.title),
      subtitle: localizedText(input.metadata.subtitle),
      description: localizedText(input.normalized.imageDisclaimer ?? ""),
    });
    commands.push({
      type: "AssignBlueprintToCatalogItem",
      blueprintId: input.catalog.blueprintId,
    });
  } else {
    commands.push({
      type: "ReviseCatalogItemMetadata",
      languageCode: input.normalized.languageCode,
      title: localizedText(input.metadata.title),
      subtitle: localizedText(input.metadata.subtitle),
      description: localizedText(input.normalized.imageDisclaimer ?? ""),
    });
  }

  commands.push(...pokemonCardFieldCommands(input.normalized, input.catalog.fieldIds, input.expansionReferenceId));

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  commands.push({
    type: "SetCatalogItemTags",
    tags: pokemonCatalogItemTags(input.profile, input.normalized),
  });
  commands.push({
    type: "SetCatalogItemImageUrls",
    imageUrls,
  });

  if (input.mode === "create") {
    if (input.productAssetSet) {
      commands.push({
        type: "SetCatalogItemProductAssetSets",
        productAssetSets: [input.productAssetSet],
      });
    }
  } else {
    commands.push({
      type: "SetCatalogItemProductAssetSets",
      productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
    });
  }

  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: `${input.normalized.languageCode}:${input.externalKey}`,
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  return commands;
}

function pokemonCardFieldCommands(
  normalized: SourceObservationPokemonCardNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  expansionReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    {
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.cardNumber,
      value: normalized.cardNumber,
    },
    {
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.cardName,
      value: localizedJsonText(normalized.name),
    },
    {
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.expansion,
      value: { referenceId: expansionReferenceId },
    },
    {
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.cardVariant,
      value: normalized.cardVariantLabel,
    },
  ];

  if (normalized.rarity) {
    commands.push({
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.rarity,
      value: normalized.rarity,
    });
  }

  if (normalized.illustrator) {
    commands.push({
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.cardIllustrator,
      value: normalized.illustrator,
    });
  }

  if (normalized.releaseYear !== null) {
    commands.push({
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.releaseYear,
      value: normalized.releaseYear,
    });
  }

  return commands;
}

function pokemonCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationPokemonCardNormalized,
): string[] {
  return [
    "pokemon",
    profile.providerKey,
    `expansion:${normalized.expansionId}`,
    `category:${normalized.category.toLowerCase()}`,
    `variant:${normalized.cardVariantKey}`,
    ...(normalized.imageDisclaimer ? ["image-note:variant-reference"] : []),
  ];
}

function uniqueExternalCatalogItemReferences(
  references: readonly NonNullable<SourceObservationPokemonCardNormalized["externalCatalogItemReferences"]>[number][],
) {
  const seen = new Set<string>();
  return references
    .map((reference) => ({
      providerKey: reference.providerKey.trim().toLowerCase(),
      externalKey: reference.externalKey.trim().toLowerCase(),
    }))
    .filter((reference) => reference.providerKey.length > 0 && reference.externalKey.length > 0)
    .filter((reference) => {
      const key = `${reference.providerKey}:${reference.externalKey}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}

function localizedJsonText(value: string): JsonObject {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}
