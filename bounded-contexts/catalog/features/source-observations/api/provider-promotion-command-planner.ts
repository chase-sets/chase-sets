import { createHash } from "node:crypto";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { ProductContentLineInput, ReplaceProductContentsInput } from "../../product-contents/api/runtime";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import {
  productAssetSetCompatibilityImageUrls,
  type ProductAssetSet,
} from "../../../support/runtime-support/product-assets";
import type {
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationLorcanaCardPrintNormalized,
  SourceObservationLorcanaSealedProductNormalized,
  SourceObservationNormalized,
  SourceObservationOnePieceCardPrintNormalized,
  SourceObservationOnePieceSealedProductNormalized,
  SourceObservationPokemonCardNormalized,
  SourceObservationPokemonSealedProductNormalized,
  SourceObservationYugiohSealedProductNormalized,
  SourceObservationProductContentsPromotion,
  SourceObservationProductContentsPromotionLine,
} from "../domain/domain";
import { sourceObservationLinkExternalKey } from "../domain/domain";
import type { CatalogProviderIntegrationProfile } from "./provider-integration-profiles";

export type CatalogProviderPromotionMode = "create" | "refresh";

export type CatalogProviderPromotionResolvedCatalogMapping = Readonly<{
  blueprintId: BlueprintId;
  categoryId: CategoryId;
  fieldIds: Readonly<{
    cardNumber: FieldId;
    cardName: FieldId;
    set?: FieldId;
    expansion: FieldId;
    rarity: FieldId;
    cardVariant: FieldId;
    cardIllustrator: FieldId;
    releaseYear: FieldId;
    packCount?: FieldId;
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
    | "missing-normalized-field"
    | "missing-product-contents-content-type"
    | "ambiguous-product-contents-content-type"
    | "missing-product-contents-target"
    | "ambiguous-product-contents-target"
    | "missing-reference-target"
    | "unsupported-observation-kind"
    | "unsupported-profile-mapping-kind"
    | CatalogProviderPromotionPreflightBlocked["code"];
  path: string;
  diagnosticText: string;
}>;

export type CatalogProviderProductContentsPromotionPlan = Readonly<{
  planKind: "product-contents-promotion";
  replacement: ReplaceProductContentsInput;
  review: Readonly<{
    lineCount: number;
  }>;
}>;

export type CatalogProviderPromotionCommandPlan = Readonly<{
  planKind: "catalog-item-promotion";
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  mappingKind: CatalogProviderIntegrationProfile["normalizedObservationMapping"]["kind"];
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  planFingerprint: string;
  requiresReview: true;
  commands: readonly CatalogItemCommand[];
  productContents: CatalogProviderProductContentsPromotionPlan | null;
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
  profileKey: string;
  profileVersion: string;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId?: ReferenceRecordId;
  setReferenceId?: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
  productContentsPromotion?: SourceObservationProductContentsPromotion | null;
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

  const commands = commandsForNormalizedKind(input);
  const productContents = productContentsPromotionPlan({
    catalogItemId: input.catalogItemId,
    promotion: input.productContentsPromotion ?? input.normalized.productContentsPromotion ?? null,
  });
  const sourceProductReferencesLinked = commands.filter(
    (command) => command.type === "LinkExternalProductReference",
  ).length;
  const planFingerprint = catalogProviderPromotionPlanFingerprint({
    providerKey: input.providerKey,
    profileKey: input.profileKey,
    profileVersion: input.profileVersion,
    mode: input.mode,
    mappingKind: input.profile.normalizedObservationMapping.kind,
    commands,
    productContents,
  });

  return {
    status: "planned",
    plan: {
      planKind: "catalog-item-promotion",
      providerKey: input.providerKey,
      profileKey: input.profileKey,
      profileVersion: input.profileVersion,
      mappingKind: input.profile.normalizedObservationMapping.kind,
      mode: input.mode,
      catalogItemId: input.catalogItemId,
      planFingerprint,
      requiresReview: true,
      commands,
      productContents,
      review: {
        normalizedKind: input.normalized.kind,
        commandCount: commands.length,
        catalogItemReferencesLinked: uniqueExternalCatalogItemReferences(
          input.normalized.externalCatalogItemReferences ?? [],
        ).length,
        sourceProductReferencesLinked,
      },
    },
    diagnostics: [],
  };
}

function promotionDiagnostics(input: {
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId?: ReferenceRecordId;
  setReferenceId?: ReferenceRecordId;
  productContentsPromotion?: SourceObservationProductContentsPromotion | null;
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

  if (input.profile.normalizedObservationMapping.kind !== input.normalized.kind) {
    diagnostics.push({
      code: "unsupported-profile-mapping-kind",
      path: "profile.normalizedObservationMapping.kind",
      diagnosticText: `Catalog promotion planning cannot use profile kind '${input.profile.normalizedObservationMapping.kind}' for normalized kind '${input.normalized.kind}'.`,
    });
  }

  if (
    input.normalized.kind !== "pokemon-card" &&
    input.normalized.kind !== "pokemon-sealed-product" &&
    input.normalized.kind !== "magic-card-print" &&
    input.normalized.kind !== "magic-sealed-product" &&
    input.normalized.kind !== "lorcana-card-print" &&
    input.normalized.kind !== "lorcana-sealed-product" &&
    input.normalized.kind !== "one-piece-card-print" &&
    input.normalized.kind !== "one-piece-sealed-product" &&
    input.normalized.kind !== "yugioh-sealed-product"
  ) {
    diagnostics.push({
      code: "unsupported-observation-kind",
      path: "normalized.kind",
      diagnosticText:
        input.normalized.kind === "magic-set-reference"
          ? "Magic Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path."
          : input.normalized.kind === "lorcana-set-reference"
            ? "Lorcana Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path."
            : input.normalized.kind === "one-piece-set-reference"
              ? "One Piece Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path."
              : `Catalog promotion planning does not support normalized kind '${input.normalized.kind}'.`,
    });
  }

  if (
    (input.normalized.kind === "pokemon-card" || input.normalized.kind === "pokemon-sealed-product") &&
    !input.expansionReferenceId
  ) {
    diagnostics.push({
      code: "missing-reference-target",
      path: "expansionReferenceId",
      diagnosticText:
        input.normalized.kind === "pokemon-card"
          ? "Pokemon card promotion requires a resolved Expansion Reference Record."
          : "Pokemon sealed product promotion requires a resolved Expansion Reference Record.",
    });
  }

  if (input.normalized.kind === "pokemon-sealed-product") {
    requireNormalizedString(input.normalized.name, "normalized.name", "Pokemon sealed product promotion", diagnostics);
    requireNormalizedString(
      input.normalized.setName,
      "normalized.setName",
      "Pokemon sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.sealedProductForm,
      "normalized.sealedProductForm",
      "Pokemon sealed product promotion",
      diagnostics,
    );
    requireNormalizedNumber(
      input.normalized.packCount,
      "normalized.packCount",
      "Pokemon sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.packCount,
      "catalog.fieldIds.packCount",
      "Pokemon sealed product promotion",
      diagnostics,
    );
  }

  if (
    (input.normalized.kind === "magic-card-print" || input.normalized.kind === "magic-sealed-product") &&
    !input.setReferenceId
  ) {
    diagnostics.push({
      code: "missing-reference-target",
      path: "setReferenceId",
      diagnosticText: "Magic promotion requires a resolved Set Reference Record.",
    });
  }

  if (input.normalized.kind === "magic-card-print") {
    requireNormalizedString(input.normalized.name, "normalized.name", "Magic card print promotion", diagnostics);
    requireNormalizedString(
      input.normalized.cardNumber,
      "normalized.cardNumber",
      "Magic card print promotion",
      diagnostics,
    );
    requireNormalizedString(input.normalized.setCode, "normalized.setCode", "Magic card print promotion", diagnostics);
    requireNormalizedString(input.normalized.setName, "normalized.setName", "Magic card print promotion", diagnostics);
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "Magic card print promotion",
      diagnostics,
    );
  }

  if (input.normalized.kind === "magic-sealed-product") {
    requireNormalizedString(input.normalized.name, "normalized.name", "Magic sealed product promotion", diagnostics);
    requireNormalizedString(
      input.normalized.setCode,
      "normalized.setCode",
      "Magic sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.setName,
      "normalized.setName",
      "Magic sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.sealedProductForm,
      "normalized.sealedProductForm",
      "Magic sealed product promotion",
      diagnostics,
    );
    requireNormalizedNumber(
      input.normalized.packCount,
      "normalized.packCount",
      "Magic sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "Magic sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.packCount,
      "catalog.fieldIds.packCount",
      "Magic sealed product promotion",
      diagnostics,
    );
  }

  if (
    (input.normalized.kind === "one-piece-card-print" || input.normalized.kind === "one-piece-sealed-product") &&
    !input.setReferenceId
  ) {
    diagnostics.push({
      code: "missing-reference-target",
      path: "setReferenceId",
      diagnosticText: "One Piece promotion requires a resolved Set Reference Record.",
    });
  }

  if (input.normalized.kind === "one-piece-card-print") {
    requireNormalizedString(input.normalized.name, "normalized.name", "One Piece card print promotion", diagnostics);
    requireNormalizedString(
      input.normalized.cardNumber,
      "normalized.cardNumber",
      "One Piece card print promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.setName,
      "normalized.setName",
      "One Piece card print promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "One Piece card print promotion",
      diagnostics,
    );
  }

  if (input.normalized.kind === "one-piece-sealed-product") {
    requireNormalizedString(
      input.normalized.name,
      "normalized.name",
      "One Piece sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.sealedProductForm,
      "normalized.sealedProductForm",
      "One Piece sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "One Piece sealed product promotion",
      diagnostics,
    );
  }

  if (
    (input.normalized.kind === "lorcana-card-print" || input.normalized.kind === "lorcana-sealed-product") &&
    !input.setReferenceId
  ) {
    diagnostics.push({
      code: "missing-reference-target",
      path: "setReferenceId",
      diagnosticText: "Lorcana promotion requires a resolved Set Reference Record.",
    });
  }

  if (input.normalized.kind === "lorcana-card-print") {
    requireNormalizedString(input.normalized.name, "normalized.name", "Lorcana card print promotion", diagnostics);
    requireNormalizedString(
      input.normalized.cardNumber,
      "normalized.cardNumber",
      "Lorcana card print promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.setName,
      "normalized.setName",
      "Lorcana card print promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "Lorcana card print promotion",
      diagnostics,
    );
  }

  if (input.normalized.kind === "lorcana-sealed-product") {
    requireNormalizedString(input.normalized.name, "normalized.name", "Lorcana sealed product promotion", diagnostics);
    requireNormalizedString(
      input.normalized.setName,
      "normalized.setName",
      "Lorcana sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.sealedProductForm,
      "normalized.sealedProductForm",
      "Lorcana sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "Lorcana sealed product promotion",
      diagnostics,
    );
  }

  if (input.normalized.kind === "yugioh-sealed-product") {
    if (!input.setReferenceId) {
      diagnostics.push({
        code: "missing-reference-target",
        path: "setReferenceId",
        diagnosticText: "Yu-Gi-Oh! sealed product promotion requires one resolved Set Reference Record.",
      });
    }
    requireNormalizedString(
      input.normalized.name,
      "normalized.name",
      "Yu-Gi-Oh! sealed product promotion",
      diagnostics,
    );
    requireNormalizedString(
      input.normalized.sealedProductForm,
      "normalized.sealedProductForm",
      "Yu-Gi-Oh! sealed product promotion",
      diagnostics,
    );
    requirePromotionField(
      input.catalog.fieldIds.set,
      "catalog.fieldIds.set",
      "Yu-Gi-Oh! sealed product promotion",
      diagnostics,
    );
  }

  if (input.preflight?.status === "blocked") {
    diagnostics.push({
      code: input.preflight.code,
      path: "preflight",
      diagnosticText: input.preflight.diagnosticText,
    });
  }

  diagnostics.push(
    ...productContentsPromotionDiagnostics({
      promotion: input.productContentsPromotion ?? input.normalized.productContentsPromotion ?? null,
    }),
  );

  return diagnostics;
}

function productContentsPromotionDiagnostics(input: {
  promotion: SourceObservationProductContentsPromotion | null;
}): CatalogProviderPromotionCommandPlanDiagnostic[] {
  if (!input.promotion || input.promotion.lines.length === 0) {
    return [];
  }

  const diagnostics: CatalogProviderPromotionCommandPlanDiagnostic[] = [];
  for (const [index, line] of input.promotion.lines.entries()) {
    const contentType = resolveProductContentsContentType(line);
    if (contentType.status === "missing") {
      diagnostics.push({
        code: "missing-product-contents-content-type",
        path: `normalized.productContentsPromotion.lines.${index}.contentTypeId`,
        diagnosticText: "Product Contents promotion requires a configured Product Content Type for each line.",
      });
    }
    if (contentType.status === "ambiguous") {
      diagnostics.push({
        code: "ambiguous-product-contents-content-type",
        path: `normalized.productContentsPromotion.lines.${index}.candidateContentTypeIds`,
        diagnosticText:
          "Product Contents promotion found multiple possible Product Content Types; review must choose one before writing Product Contents.",
      });
    }

    const target = resolveProductContentsTarget(line);
    if (target.status === "missing") {
      diagnostics.push({
        code: "missing-product-contents-target",
        path: `normalized.productContentsPromotion.lines.${index}.candidateCatalogItemIds`,
        diagnosticText: "Product Contents promotion requires one reviewed contained Catalog Item target for each line.",
      });
    }
    if (target.status === "ambiguous") {
      diagnostics.push({
        code: "ambiguous-product-contents-target",
        path: `normalized.productContentsPromotion.lines.${index}.candidateCatalogItemIds`,
        diagnosticText:
          "Product Contents promotion found multiple possible contained Catalog Item targets; review must choose one before writing Product Contents.",
      });
    }
  }

  return diagnostics;
}

function productContentsPromotionPlan(input: {
  catalogItemId: CatalogItemId;
  promotion: SourceObservationProductContentsPromotion | null;
}): CatalogProviderProductContentsPromotionPlan | null {
  if (!input.promotion || input.promotion.lines.length === 0) {
    return null;
  }

  const lines: ProductContentLineInput[] = input.promotion.lines.map((line) => {
    const target = resolveProductContentsTarget(line);
    const contentType = resolveProductContentsContentType(line);
    return {
      containedCatalogItemId: target.status === "resolved" ? target.catalogItemId : null,
      containedSelectedOptions: line.containedSelectedOptions ?? [],
      quantity: typeof line.quantity === "number" ? line.quantity : null,
      contentTypeId: contentType.status === "resolved" ? contentType.contentTypeId : "",
      inclusionPolicyId: line.inclusionPolicyId ?? null,
      provenance: line.provenance ?? {},
    };
  });

  return {
    planKind: "product-contents-promotion",
    replacement: {
      containerCatalogItemId: input.catalogItemId,
      lines,
    },
    review: { lineCount: lines.length },
  };
}

function resolveProductContentsContentType(
  line: SourceObservationProductContentsPromotionLine,
):
  | Readonly<{ status: "resolved"; contentTypeId: string }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ambiguous" }> {
  const direct = nonEmptyString(line.contentTypeId) ? line.contentTypeId.trim() : null;
  if (direct) {
    return { status: "resolved", contentTypeId: direct };
  }

  const candidates = uniqueStrings(line.candidateContentTypeIds ?? []);
  if (candidates.length === 1) {
    return { status: "resolved", contentTypeId: candidates[0] };
  }
  if (candidates.length === 0) {
    return { status: "missing" };
  }
  return { status: "ambiguous" };
}

function resolveProductContentsTarget(
  line: SourceObservationProductContentsPromotionLine,
):
  | Readonly<{ status: "resolved"; catalogItemId: CatalogItemId }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ambiguous" }> {
  const direct = nonEmptyString(line.containedCatalogItemId) ? line.containedCatalogItemId.trim() : null;
  if (direct) {
    return { status: "resolved", catalogItemId: direct as CatalogItemId };
  }

  const candidates = uniqueStrings(line.candidateCatalogItemIds ?? []);
  if (candidates.length === 1) {
    return { status: "resolved", catalogItemId: candidates[0] as CatalogItemId };
  }
  if (candidates.length === 0) {
    return { status: "missing" };
  }
  return { status: "ambiguous" };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function requireNormalizedString(
  value: string | null | undefined,
  path: string,
  owner: string,
  diagnostics: CatalogProviderPromotionCommandPlanDiagnostic[],
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    return;
  }
  diagnostics.push({
    code: "missing-normalized-field",
    path,
    diagnosticText: `${owner} requires a non-empty normalized field at '${path}'.`,
  });
}

function requireNormalizedNumber(
  value: number | null | undefined,
  path: string,
  owner: string,
  diagnostics: CatalogProviderPromotionCommandPlanDiagnostic[],
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  diagnostics.push({
    code: "missing-normalized-field",
    path,
    diagnosticText: `${owner} requires a finite normalized number at '${path}'.`,
  });
}

function requirePromotionField(
  fieldId: FieldId | undefined,
  path: string,
  owner: string,
  diagnostics: CatalogProviderPromotionCommandPlanDiagnostic[],
): void {
  if (fieldId) {
    return;
  }
  diagnostics.push({
    code: "missing-normalized-field",
    path,
    diagnosticText: `${owner} requires this Catalog field mapping.`,
  });
}

function commandsForNormalizedKind(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId?: ReferenceRecordId;
  setReferenceId?: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  switch (input.normalized.kind) {
    case "pokemon-card":
      return pokemonCardCommands({
        ...input,
        normalized: input.normalized,
        expansionReferenceId: input.expansionReferenceId as ReferenceRecordId,
      });
    case "pokemon-sealed-product":
      return pokemonSealedProductCommands({
        ...input,
        normalized: input.normalized,
        expansionReferenceId: input.expansionReferenceId as ReferenceRecordId,
      });
    case "magic-card-print":
      return magicCardPrintCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "magic-sealed-product":
      return magicSealedProductCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "one-piece-card-print":
      return onePieceCardPrintCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "one-piece-sealed-product":
      return onePieceSealedProductCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "lorcana-card-print":
      return lorcanaCardPrintCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "lorcana-sealed-product":
      return lorcanaSealedProductCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "yugioh-sealed-product":
      return yugiohSealedProductCommands({
        ...input,
        normalized: input.normalized,
        setReferenceId: input.setReferenceId as ReferenceRecordId,
      });
    case "magic-set-reference":
    case "lorcana-set-reference":
    case "provider-product":
    case "yugioh-card-print":
    case "yugioh-set-reference":
    case "yugioh-pack-reference":
    case "one-piece-set-reference":
      return [];
  }
}

function yugiohSealedProductCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationYugiohSealedProductNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonYugiohCatalogItemCommands(input, yugiohCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...yugiohSealedProductFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function commonYugiohCatalogItemCommands(
  input: {
    providerKey: string;
    externalKey: string;
    mode: CatalogProviderPromotionMode;
    catalogItemId: CatalogItemId;
    normalized: SourceObservationYugiohSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    metadata: Readonly<{ title: string; subtitle: string }>;
    productAssetSet: ProductAssetSet | null;
  },
  tags: readonly string[],
): CatalogItemCommand[] {
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
      description: localizedText(""),
    });
    commands.push({ type: "AssignBlueprintToCatalogItem", blueprintId: input.catalog.blueprintId });
  } else {
    commands.push({
      type: "ReviseCatalogItemMetadata",
      languageCode: input.normalized.languageCode,
      title: localizedText(input.metadata.title),
      subtitle: localizedText(input.metadata.subtitle),
      description: localizedText(""),
    });
  }

  if (input.mode === "create") {
    commands.push({ type: "AssignCatalogItemToCategory", categoryId: input.catalog.categoryId });
  }

  commands.push({ type: "SetCatalogItemTags", tags: [...tags] });
  commands.push({ type: "SetCatalogItemImageUrls", imageUrls });
  commands.push({
    type: "SetCatalogItemProductAssetSets",
    productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
  });
  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }
  for (const reference of uniqueExternalProductReferences(input.normalized.externalProductReferences ?? [])) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
    });
  }

  return commands;
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
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
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

function pokemonSealedProductCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationPokemonSealedProductNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  expansionReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonPokemonSealedProductCatalogItemCommands(
    input,
    pokemonSealedProductCatalogItemTags(input.profile, input.normalized),
  );
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...pokemonSealedProductFieldCommands(input.normalized, input.catalog.fieldIds, input.expansionReferenceId),
  );
  return commands;
}

function commonPokemonSealedProductCatalogItemCommands(
  input: {
    providerKey: string;
    externalKey: string;
    mode: CatalogProviderPromotionMode;
    catalogItemId: CatalogItemId;
    normalized: SourceObservationPokemonSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    metadata: Readonly<{ title: string; subtitle: string }>;
    productAssetSet: ProductAssetSet | null;
  },
  tags: readonly string[],
): CatalogItemCommand[] {
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
      description: localizedText(""),
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
      description: localizedText(""),
    });
  }

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  commands.push({ type: "SetCatalogItemTags", tags: [...tags] });
  commands.push({ type: "SetCatalogItemImageUrls", imageUrls });
  commands.push({
    type: "SetCatalogItemProductAssetSets",
    productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
  });
  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  for (const reference of uniqueExternalProductReferences(input.normalized.externalProductReferences ?? [])) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
    });
  }

  return commands;
}

function magicCardPrintCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationMagicCardPrintNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonMagicCatalogItemCommands(input, magicCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...magicCardPrintFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function magicSealedProductCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationMagicSealedProductNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonMagicCatalogItemCommands(input, magicCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...magicSealedProductFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function onePieceCardPrintCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationOnePieceCardPrintNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonOnePieceCatalogItemCommands(input, onePieceCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...onePieceCardPrintFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function onePieceSealedProductCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationOnePieceSealedProductNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonOnePieceCatalogItemCommands(input, onePieceCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...onePieceSealedProductFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function lorcanaCardPrintCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationLorcanaCardPrintNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonLorcanaCatalogItemCommands(input, lorcanaCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...lorcanaCardPrintFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function lorcanaSealedProductCommands(input: {
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  mode: CatalogProviderPromotionMode;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationLorcanaSealedProductNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
  setReferenceId: ReferenceRecordId;
  metadata: Readonly<{ title: string; subtitle: string }>;
  productAssetSet: ProductAssetSet | null;
}): readonly CatalogItemCommand[] {
  const commands = commonLorcanaCatalogItemCommands(input, lorcanaCatalogItemTags(input.profile, input.normalized));
  commands.splice(
    input.mode === "create" ? 2 : 1,
    0,
    ...lorcanaSealedProductFieldCommands(input.normalized, input.catalog.fieldIds, input.setReferenceId),
  );
  return commands;
}

function commonLorcanaCatalogItemCommands(
  input: {
    providerKey: string;
    externalKey: string;
    mode: CatalogProviderPromotionMode;
    catalogItemId: CatalogItemId;
    normalized: SourceObservationLorcanaCardPrintNormalized | SourceObservationLorcanaSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    metadata: Readonly<{ title: string; subtitle: string }>;
    productAssetSet: ProductAssetSet | null;
  },
  tags: readonly string[],
): CatalogItemCommand[] {
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
      description: localizedText(""),
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
      description: localizedText(""),
    });
  }

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  commands.push({ type: "SetCatalogItemTags", tags: [...tags] });
  commands.push({ type: "SetCatalogItemImageUrls", imageUrls });
  commands.push({
    type: "SetCatalogItemProductAssetSets",
    productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
  });
  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  for (const reference of uniqueExternalProductReferences(input.normalized.externalProductReferences ?? [])) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
    });
  }

  return commands;
}

function commonOnePieceCatalogItemCommands(
  input: {
    providerKey: string;
    externalKey: string;
    mode: CatalogProviderPromotionMode;
    catalogItemId: CatalogItemId;
    normalized: SourceObservationOnePieceCardPrintNormalized | SourceObservationOnePieceSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    metadata: Readonly<{ title: string; subtitle: string }>;
    productAssetSet: ProductAssetSet | null;
  },
  tags: readonly string[],
): CatalogItemCommand[] {
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
      description: localizedText(""),
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
      description: localizedText(""),
    });
  }

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  commands.push({ type: "SetCatalogItemTags", tags: [...tags] });
  commands.push({ type: "SetCatalogItemImageUrls", imageUrls });
  commands.push({
    type: "SetCatalogItemProductAssetSets",
    productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
  });
  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  for (const reference of uniqueExternalProductReferences(input.normalized.externalProductReferences ?? [])) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
    });
  }

  return commands;
}

function commonMagicCatalogItemCommands(
  input: {
    providerKey: string;
    externalKey: string;
    mode: CatalogProviderPromotionMode;
    catalogItemId: CatalogItemId;
    normalized: SourceObservationMagicCardPrintNormalized | SourceObservationMagicSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    metadata: Readonly<{ title: string; subtitle: string }>;
    productAssetSet: ProductAssetSet | null;
  },
  tags: readonly string[],
): CatalogItemCommand[] {
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
      description: localizedText(""),
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
      description: localizedText(""),
    });
  }

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  commands.push({ type: "SetCatalogItemTags", tags: [...tags] });
  commands.push({ type: "SetCatalogItemImageUrls", imageUrls });
  commands.push({
    type: "SetCatalogItemProductAssetSets",
    productAssetSets: input.productAssetSet ? [input.productAssetSet] : [],
  });
  commands.push({
    type: "LinkExternalProductReference",
    providerKey: input.providerKey,
    externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
  });

  for (const reference of uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? [])) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  for (const reference of uniqueExternalProductReferences(input.normalized.externalProductReferences ?? [])) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
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

function pokemonSealedProductFieldCommands(
  normalized: SourceObservationPokemonSealedProductNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  expansionReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.expansion, value: { referenceId: expansionReferenceId } },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.packCount as FieldId, value: normalized.packCount },
  ];

  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function magicCardPrintFieldCommands(
  normalized: SourceObservationMagicCardPrintNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardNumber, value: normalized.cardNumber },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
  ];

  if (normalized.rarity) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.rarity, value: normalized.rarity });
  }
  if (normalized.cardVariantLabel) {
    commands.push({
      type: "SetCatalogItemFieldValue",
      fieldId: fieldIds.cardVariant,
      value: normalized.cardVariantLabel,
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
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function magicSealedProductFieldCommands(
  normalized: SourceObservationMagicSealedProductNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.packCount as FieldId, value: normalized.packCount },
  ];

  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function onePieceCardPrintFieldCommands(
  normalized: SourceObservationOnePieceCardPrintNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardNumber, value: normalized.cardNumber },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
  ];

  if (normalized.rarity) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.rarity, value: normalized.rarity });
  }
  if (normalized.cardType) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardVariant, value: normalized.cardType });
  }
  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function onePieceSealedProductFieldCommands(
  normalized: SourceObservationOnePieceSealedProductNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardVariant, value: normalized.sealedProductForm },
  ];

  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function lorcanaCardPrintFieldCommands(
  normalized: SourceObservationLorcanaCardPrintNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardNumber, value: normalized.cardNumber },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
  ];

  if (normalized.rarity) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.rarity, value: normalized.rarity });
  }
  if (normalized.cardType) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardVariant, value: normalized.cardType });
  }
  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function lorcanaSealedProductFieldCommands(
  normalized: SourceObservationLorcanaSealedProductNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardVariant, value: normalized.sealedProductForm },
  ];

  if (normalized.releaseYear !== null) {
    commands.push({ type: "SetCatalogItemFieldValue", fieldId: fieldIds.releaseYear, value: normalized.releaseYear });
  }

  return commands;
}

function yugiohSealedProductFieldCommands(
  normalized: SourceObservationYugiohSealedProductNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  setReferenceId: ReferenceRecordId,
): readonly CatalogItemCommand[] {
  return [
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardName, value: localizedJsonText(normalized.name) },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.set as FieldId, value: { referenceId: setReferenceId } },
    { type: "SetCatalogItemFieldValue", fieldId: fieldIds.cardVariant, value: normalized.sealedProductForm },
  ];
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

function pokemonSealedProductCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationPokemonSealedProductNormalized,
): string[] {
  return [
    "pokemon",
    profile.providerKey,
    `set:${slugTagValue(normalized.setName)}`,
    `kind:${normalized.kind}`,
    `form:${normalized.sealedProductForm}`,
  ];
}

function magicCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationMagicCardPrintNormalized | SourceObservationMagicSealedProductNormalized,
): string[] {
  return [
    "magic",
    profile.providerKey,
    `set:${normalized.setCode.toLowerCase()}`,
    `kind:${normalized.kind}`,
    ...(normalized.kind === "magic-card-print" && normalized.cardVariantKey
      ? [`variant:${normalized.cardVariantKey}`]
      : []),
    ...(normalized.kind === "magic-sealed-product" ? [`form:${normalized.sealedProductForm}`] : []),
  ];
}

function onePieceCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationOnePieceCardPrintNormalized | SourceObservationOnePieceSealedProductNormalized,
): string[] {
  return [
    "one-piece",
    profile.providerKey,
    ...(normalized.setCode ? [`set:${normalized.setCode.toLowerCase()}`] : []),
    `kind:${normalized.kind}`,
    ...(normalized.kind === "one-piece-card-print" && normalized.cardType
      ? [`card-type:${normalized.cardType.toLowerCase()}`]
      : []),
    ...(normalized.kind === "one-piece-sealed-product" ? [`form:${normalized.sealedProductForm}`] : []),
  ];
}

function lorcanaCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationLorcanaCardPrintNormalized | SourceObservationLorcanaSealedProductNormalized,
): string[] {
  const setTag = normalized.setCode ?? normalized.setId ?? normalized.setName;
  return [
    "lorcana",
    profile.providerKey,
    ...(setTag ? [`set:${slugTagValue(setTag)}`] : []),
    `kind:${normalized.kind}`,
    ...(normalized.kind === "lorcana-card-print" && normalized.cardType
      ? [`card-type:${slugTagValue(normalized.cardType)}`]
      : []),
    ...(normalized.kind === "lorcana-card-print" && normalized.inkColor
      ? [`ink:${slugTagValue(normalized.inkColor)}`]
      : []),
    ...(normalized.kind === "lorcana-sealed-product" ? [`form:${normalized.sealedProductForm}`] : []),
  ];
}

function yugiohCatalogItemTags(
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationYugiohSealedProductNormalized,
): string[] {
  const setId = normalized.boxOfSetEvidence?.find((candidate) => candidate.trim().length > 0);
  return [
    "yugioh",
    profile.providerKey,
    ...(setId ? [`set:${slugTagValue(setId)}`] : []),
    `kind:${normalized.kind}`,
    `form:${normalized.sealedProductForm}`,
  ];
}

function slugTagValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueExternalCatalogItemReferences(
  references: readonly NonNullable<SourceObservationNormalized["externalCatalogItemReferences"]>[number][],
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

function uniqueExternalProductReferences(
  references: readonly NonNullable<SourceObservationNormalized["externalProductReferences"]>[number][],
) {
  const seen = new Set<string>();
  return references
    .map((reference) => ({
      ...reference,
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

export function catalogProviderPromotionPlanFingerprint(input: {
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  mappingKind: string;
  mode: CatalogProviderPromotionMode;
  commands: readonly CatalogItemCommand[];
  productContents?: CatalogProviderProductContentsPromotionPlan | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerKey: input.providerKey,
        profileKey: input.profileKey,
        profileVersion: input.profileVersion,
        mappingKind: input.mappingKind,
        mode: input.mode,
        commands: input.commands,
        productContents: input.productContents ?? null,
      }),
    )
    .digest("hex");
}
