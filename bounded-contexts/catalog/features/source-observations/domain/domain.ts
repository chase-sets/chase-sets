import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import { assert, assertNever } from "../../../support/runtime-support/common";

export type SourceObservationStatus = "observed" | "changed" | "promoted" | "rejected";

export type SourceObservationSourceProfileEvidence = Readonly<{
  sourceProfileKey: string;
  sourceProfileVersion: string;
  sourceMappingFingerprint: string;
}>;

export type SourceObservationPromotionProfileEvidence = Readonly<{
  promotionProfileKey: string;
  promotionProfileVersion: string;
  promotionPlanFingerprint: string;
}>;

export type SourceObservationExternalCatalogItemReference = Readonly<{
  providerKey: string;
  externalKey: string;
}>;

export type SourceObservationExternalProductReference = Readonly<{
  providerKey: string;
  externalKey: string;
  selectedOptions?: readonly SourceObservationSelectedOptionReference[];
  reviewEvidence?: JsonObject;
}>;

export type SourceObservationSelectedOptionReference = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type SourceObservationMergeIdentity = Readonly<{
  tcg: string;
  productLineName: string | null;
  setName: string | null;
  printedProductName: string;
  collectorNumber: string | null;
  languageCode: string;
  productForm?: string | null;
  barcode?: string | null;
}>;

export type SourceObservationNormalizedKind =
  | "pokemon-card"
  | "provider-product"
  | "magic-card-print"
  | "magic-set-reference"
  | "magic-sealed-product"
  | "yugioh-card-print"
  | "yugioh-set-reference"
  | "yugioh-sealed-product"
  | "yugioh-pack-reference"
  | "one-piece-card-print"
  | "one-piece-set-reference"
  | "one-piece-sealed-product";

export type SourceObservationNormalizedBase = Readonly<{
  kind: SourceObservationNormalizedKind;
  languageCode: string;
  name: string;
  setName: string | null;
  expansionName: string | null;
  cardNumber: string | null;
  imageUrls: readonly string[];
  mergeIdentity?: SourceObservationMergeIdentity;
  externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  externalProductReferences?: readonly SourceObservationExternalProductReference[];
}>;

export type SourceObservationPokemonCardNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "pokemon-card";
    tcg: "pokemon";
    languageCode: string;
    name: string;
    cardNumber: string;
    setId: string;
    setName: string;
    expansionId: string;
    expansionName: string;
    expansionAbbreviation: string | null;
    expansionCardCount: number | null;
    expansionParallelSetCardCount: number | null;
    seriesId: string | null;
    seriesName: string | null;
    rarity: string | null;
    illustrator: string | null;
    releaseDate: string | null;
    releaseYear: number | null;
    category: string;
    imageBaseUrl: string | null;
    imageUrls: readonly string[];
    productAssetSet: ProductAssetSet | null;
    parallelSet: boolean;
    cardVariantKey: string;
    cardVariantLabel: string;
    cardVariantSourceKey: string | null;
    cardVariantIsPrimaryImage: boolean;
    imageDisclaimer: string | null;
    variants: JsonObject;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationProviderProductNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "provider-product";
    providerProductId: string;
    providerProductName: string;
    productLineName: string | null;
    productCategoryName: string | null;
    skuReferences: readonly SourceObservationExternalProductReference[];
  }>;

export type SourceObservationMagicCardPrintNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "magic-card-print";
    tcg: "magic";
    languageCode: string;
    name: string;
    cardNumber: string;
    setCode: string;
    setName: string;
    setId: string | null;
    oracleId: string | null;
    rarity: string | null;
    illustrator: string | null;
    releaseDate: string | null;
    releaseYear: number | null;
    cardVariantKey: string | null;
    cardVariantLabel: string | null;
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationMagicSetReferenceNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "magic-set-reference";
    tcg: "magic";
    languageCode: string;
    name: string;
    setCode: string;
    setName: string;
    setId: string | null;
    releaseDate: string | null;
    releaseYear: number | null;
    cardCount: number | null;
    productLineName: "Magic: The Gathering";
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationMagicSealedProductNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "magic-sealed-product";
    tcg: "magic";
    languageCode: string;
    name: string;
    setCode: string;
    setName: string;
    setId: string | null;
    sealedProductForm: "booster-pack" | "booster-box" | "bundle" | "deck" | "sealed-product";
    packCount: number;
    releaseDate: string | null;
    releaseYear: number | null;
    productLineName: "Magic: The Gathering";
    barcode: string | null;
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
    externalProductReferences?: readonly SourceObservationExternalProductReference[];
  }>;

export type SourceObservationYugiohCardPrintNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "yugioh-card-print";
    tcg: "yugioh";
    languageCode: string;
    name: string;
    cardNumber: string | null;
    passcode: string | null;
    setCode: string | null;
    setName: string;
    rarity: string | null;
    cardType: string | null;
    attribute: string | null;
    archetype: string | null;
    releaseDate: string | null;
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationYugiohSetReferenceNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "yugioh-set-reference";
    tcg: "yugioh";
    languageCode: string;
    name: string;
    setCode: string | null;
    setName: string;
    releaseDate: string | null;
    cardCount: number | null;
    productLineName: "Yu-Gi-Oh!";
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationYugiohSealedProductNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "yugioh-sealed-product";
    tcg: "yugioh";
    languageCode: string;
    name: string;
    setCode: string | null;
    setName: string | null;
    sealedProductForm: "booster-pack" | "booster-box" | "deck" | "tin" | "sealed-product";
    releaseDate: string | null;
    productLineName: "Yu-Gi-Oh!";
    barcode: string | null;
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
    externalProductReferences?: readonly SourceObservationExternalProductReference[];
  }>;

export type SourceObservationYugiohPackReferenceNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "yugioh-pack-reference";
    tcg: "yugioh";
    languageCode: string;
    name: string;
    setCode: string | null;
    setName: string | null;
    packName: string;
    oddsSummary: JsonObject | null;
    contentsSummary: JsonObject | null;
    productLineName: "Yu-Gi-Oh!";
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationOnePieceCardPrintNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "one-piece-card-print";
    tcg: "one-piece";
    languageCode: string;
    name: string;
    cardNumber: string;
    setId: string;
    setCode: string | null;
    setName: string;
    rarity: string | null;
    cardType: string | null;
    releaseDate: string | null;
    releaseYear: number | null;
    productLineName: "One Piece Card Game";
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
    externalProductReferences?: readonly SourceObservationExternalProductReference[];
  }>;

export type SourceObservationOnePieceSetReferenceNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "one-piece-set-reference";
    tcg: "one-piece";
    languageCode: string;
    name: string;
    setId: string;
    setCode: string | null;
    setName: string;
    releaseDate: string | null;
    releaseYear: number | null;
    cardCount: number | null;
    productLineName: "One Piece Card Game";
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
  }>;

export type SourceObservationOnePieceSealedProductNormalized = JsonObject &
  SourceObservationNormalizedBase &
  Readonly<{
    kind: "one-piece-sealed-product";
    tcg: "one-piece";
    languageCode: string;
    name: string;
    setId: string | null;
    setCode: string | null;
    setName: string | null;
    sealedProductForm: "booster-pack" | "booster-box" | "starter-deck" | "deck" | "sealed-product";
    releaseDate: string | null;
    releaseYear: number | null;
    productLineName: "One Piece Card Game";
    barcode: string | null;
    imageUrls: readonly string[];
    mergeIdentity?: SourceObservationMergeIdentity;
    externalCatalogItemReferences?: readonly SourceObservationExternalCatalogItemReference[];
    externalProductReferences?: readonly SourceObservationExternalProductReference[];
  }>;

export type SourceObservationNormalized =
  | SourceObservationPokemonCardNormalized
  | SourceObservationProviderProductNormalized
  | SourceObservationMagicCardPrintNormalized
  | SourceObservationMagicSetReferenceNormalized
  | SourceObservationMagicSealedProductNormalized
  | SourceObservationYugiohCardPrintNormalized
  | SourceObservationYugiohSetReferenceNormalized
  | SourceObservationYugiohSealedProductNormalized
  | SourceObservationYugiohPackReferenceNormalized
  | SourceObservationOnePieceCardPrintNormalized
  | SourceObservationOnePieceSetReferenceNormalized
  | SourceObservationOnePieceSealedProductNormalized;

export function isPokemonCardSourceObservationNormalized(
  normalized: SourceObservationNormalized,
): normalized is SourceObservationPokemonCardNormalized {
  return normalized.kind === "pokemon-card";
}

export function isMagicCatalogItemSourceObservationNormalized(
  normalized: SourceObservationNormalized,
): normalized is SourceObservationMagicCardPrintNormalized | SourceObservationMagicSealedProductNormalized {
  return normalized.kind === "magic-card-print" || normalized.kind === "magic-sealed-product";
}

export function isMagicSetReferenceSourceObservationNormalized(
  normalized: SourceObservationNormalized,
): normalized is SourceObservationMagicSetReferenceNormalized {
  return normalized.kind === "magic-set-reference";
}

export function isOnePieceCatalogItemSourceObservationNormalized(
  normalized: SourceObservationNormalized,
): normalized is SourceObservationOnePieceCardPrintNormalized | SourceObservationOnePieceSealedProductNormalized {
  return normalized.kind === "one-piece-card-print" || normalized.kind === "one-piece-sealed-product";
}

export function isOnePieceSetReferenceSourceObservationNormalized(
  normalized: SourceObservationNormalized,
): normalized is SourceObservationOnePieceSetReferenceNormalized {
  return normalized.kind === "one-piece-set-reference";
}

export type SourceObservationState = Readonly<{
  id: string | null;
  providerKey: string;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string | null;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  sourceMappingFingerprint: string;
  normalized: SourceObservationNormalized | null;
  sourcePayload: JsonValue;
  status: SourceObservationStatus;
  statusReason: string | null;
  promotedCatalogItemId: string | null;
  promotedReferenceRecordId: string | null;
  promotedAt: string | null;
  promotionProfileKey: string | null;
  promotionProfileVersion: string | null;
  promotionPlanFingerprint: string | null;
}>;

export const initialSourceObservationState: SourceObservationState = {
  id: null,
  providerKey: "",
  externalKey: "",
  sourceUrl: "",
  languageCode: "en",
  sourceRecordHash: "",
  sourceUpdatedAt: null,
  observedAt: null,
  sourceProfileKey: "",
  sourceProfileVersion: "",
  sourceMappingFingerprint: "",
  normalized: null,
  sourcePayload: null,
  status: "observed",
  statusReason: null,
  promotedCatalogItemId: null,
  promotedReferenceRecordId: null,
  promotedAt: null,
  promotionProfileKey: null,
  promotionProfileVersion: null,
  promotionPlanFingerprint: null,
};

export type RecordSourceObservationCommand = Readonly<{
  type: "RecordSourceObservation";
  observationId: string;
  providerKey: string;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt?: string | null;
  observedAt: string;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  sourceMappingFingerprint: string;
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
}>;

export type PromoteSourceObservationCommand = Readonly<{
  type: "PromoteSourceObservation";
  catalogItemId: string;
  promotedAt: string;
  promotionProfileKey: string;
  promotionProfileVersion: string;
  promotionPlanFingerprint: string;
}>;

export type PromoteSourceObservationReferenceCommand = Readonly<{
  type: "PromoteSourceObservationReference";
  referenceRecordId: string;
  promotedAt: string;
  promotionProfileKey: string;
  promotionProfileVersion: string;
  promotionPlanFingerprint: string;
}>;

export type RecordSourceObservationPromotionPlanCommand = Readonly<{
  type: "RecordSourceObservationPromotionPlan";
  catalogItemId: string;
  promotionProfileKey: string;
  promotionProfileVersion: string;
  promotionPlanFingerprint: string;
}>;

export type RecordSourceObservationReferencePromotionPlanCommand = Readonly<{
  type: "RecordSourceObservationReferencePromotionPlan";
  referenceRecordId: string;
  promotionProfileKey: string;
  promotionProfileVersion: string;
  promotionPlanFingerprint: string;
}>;

export type RejectSourceObservationCommand = Readonly<{
  type: "RejectSourceObservation";
  reason: string;
}>;

export type DeferSourceObservationCommand = Readonly<{
  type: "DeferSourceObservation";
  reason: string;
  deferredAt: string;
}>;

export type SourceObservationCommand =
  | RecordSourceObservationCommand
  | PromoteSourceObservationCommand
  | PromoteSourceObservationReferenceCommand
  | RecordSourceObservationPromotionPlanCommand
  | RecordSourceObservationReferencePromotionPlanCommand
  | RejectSourceObservationCommand
  | DeferSourceObservationCommand;

type SourceObservationRecordEventData = JsonObject &
  Omit<RecordSourceObservationCommand, "type" | "sourceUpdatedAt"> &
  Readonly<{ sourceUpdatedAt: string | null }>;

export type SourceObservationRecordedEvent = DomainEvent<
  "catalog.source-observation.recorded",
  SourceObservationRecordEventData
>;

export type SourceObservationChangedEvent = DomainEvent<
  "catalog.source-observation.changed",
  SourceObservationRecordEventData
>;

export type SourceObservationRefreshedEvent = DomainEvent<
  "catalog.source-observation.refreshed",
  SourceObservationRecordEventData &
    Readonly<{
      status: SourceObservationStatus;
      statusReason: string | null;
      promotedCatalogItemId: string | null;
      promotedReferenceRecordId: string | null;
      promotedAt: string | null;
      promotionProfileKey: string | null;
      promotionProfileVersion: string | null;
      promotionPlanFingerprint: string | null;
    }>
>;

export type SourceObservationPromotedEvent = DomainEvent<
  "catalog.source-observation.promoted",
  Readonly<{
    catalogItemId: string;
    promotedAt: string;
    promotionProfileKey: string;
    promotionProfileVersion: string;
    promotionPlanFingerprint: string;
  }>
>;

export type SourceObservationReferencePromotedEvent = DomainEvent<
  "catalog.source-observation.reference-promoted",
  Readonly<{
    referenceRecordId: string;
    promotedAt: string;
    promotionProfileKey: string;
    promotionProfileVersion: string;
    promotionPlanFingerprint: string;
  }>
>;

export type SourceObservationPromotionPlanRecordedEvent = DomainEvent<
  "catalog.source-observation.promotion-plan-recorded",
  Readonly<{
    catalogItemId: string;
    promotionProfileKey: string;
    promotionProfileVersion: string;
    promotionPlanFingerprint: string;
  }>
>;

export type SourceObservationReferencePromotionPlanRecordedEvent = DomainEvent<
  "catalog.source-observation.reference-promotion-plan-recorded",
  Readonly<{
    referenceRecordId: string;
    promotionProfileKey: string;
    promotionProfileVersion: string;
    promotionPlanFingerprint: string;
  }>
>;

export type SourceObservationRejectedEvent = DomainEvent<
  "catalog.source-observation.rejected",
  Readonly<{
    reason: string;
  }>
>;

export type SourceObservationDeferredEvent = DomainEvent<
  "catalog.source-observation.deferred",
  Readonly<{
    reason: string;
    deferredAt: string;
    reviewStatus: Extract<SourceObservationStatus, "observed" | "changed">;
  }>
>;

export type SourceObservationEvent =
  | SourceObservationRecordedEvent
  | SourceObservationChangedEvent
  | SourceObservationRefreshedEvent
  | SourceObservationPromotedEvent
  | SourceObservationReferencePromotedEvent
  | SourceObservationPromotionPlanRecordedEvent
  | SourceObservationReferencePromotionPlanRecordedEvent
  | SourceObservationRejectedEvent
  | SourceObservationDeferredEvent;

export const decideSourceObservation: AggregateDecider<
  SourceObservationState,
  SourceObservationCommand,
  SourceObservationEvent
> = (state, command) => {
  switch (command.type) {
    case "RecordSourceObservation":
      assert(command.observationId.trim().length > 0, "Source observations require an ID.");
      assert(command.providerKey.trim().length > 0, "Source observations require a provider.");
      assert(command.externalKey.trim().length > 0, "Source observations require an external key.");
      assert(command.sourceRecordHash.trim().length > 0, "Source observations require a source hash.");
      assert(command.sourceProfileKey.trim().length > 0, "Source observations require a source profile key.");
      assert(command.sourceProfileVersion.trim().length > 0, "Source observations require a source profile version.");
      assert(
        command.sourceMappingFingerprint.trim().length > 0,
        "Source observations require a source mapping fingerprint.",
      );
      assertLaunchProfileMarker(command.sourceProfileKey, "Source observation source profile key");
      assertLaunchProfileMarker(command.sourceProfileVersion, "Source observation source profile version");
      assertLaunchProfileMarker(command.sourceMappingFingerprint, "Source observation source mapping fingerprint");

      if (state.id !== null) {
        if (
          state.sourceRecordHash === command.sourceRecordHash &&
          state.sourceUpdatedAt === (command.sourceUpdatedAt ?? null) &&
          state.sourceProfileKey === normalizeKey(command.sourceProfileKey) &&
          state.sourceProfileVersion === command.sourceProfileVersion.trim() &&
          state.sourceMappingFingerprint === command.sourceMappingFingerprint.trim()
        ) {
          return [
            {
              type: "catalog.source-observation.refreshed",
              data: {
                ...recordEventData(command),
                status: state.status,
                statusReason: state.statusReason,
                promotedCatalogItemId: state.promotedCatalogItemId,
                promotedReferenceRecordId: state.promotedReferenceRecordId,
                promotedAt: state.promotedAt,
                promotionProfileKey: state.promotionProfileKey,
                promotionProfileVersion: state.promotionProfileVersion,
                promotionPlanFingerprint: state.promotionPlanFingerprint,
              },
            },
          ];
        }

        assert(
          state.status === "observed" || state.status === "changed" || state.status === "promoted",
          "Only observed, changed, or promoted source observations can be refreshed.",
        );

        if (state.status === "changed" || state.status === "promoted") {
          return [
            {
              type: "catalog.source-observation.changed",
              data: recordEventData(command),
            },
          ];
        }
      }

      return [
        {
          type: "catalog.source-observation.recorded",
          data: recordEventData(command),
        },
      ];
    case "PromoteSourceObservation":
      requirePromotable(state);
      assert(command.catalogItemId.trim().length > 0, "Promotion requires a catalog item.");
      assert(command.promotionProfileKey.trim().length > 0, "Promotion requires a profile key.");
      assert(command.promotionProfileVersion.trim().length > 0, "Promotion requires a profile version.");
      assert(command.promotionPlanFingerprint.trim().length > 0, "Promotion requires a plan fingerprint.");
      assertLaunchProfileMarker(command.promotionProfileKey, "Promotion profile key");
      assertLaunchProfileMarker(command.promotionProfileVersion, "Promotion profile version");
      assertLaunchProfileMarker(command.promotionPlanFingerprint, "Promotion plan fingerprint");

      return [
        {
          type: "catalog.source-observation.promoted",
          data: {
            catalogItemId: command.catalogItemId.trim(),
            promotedAt: command.promotedAt,
            promotionProfileKey: normalizeKey(command.promotionProfileKey),
            promotionProfileVersion: command.promotionProfileVersion.trim(),
            promotionPlanFingerprint: command.promotionPlanFingerprint.trim(),
          },
        },
      ];
    case "PromoteSourceObservationReference":
      requirePromotable(state);
      assert(command.referenceRecordId.trim().length > 0, "Reference promotion requires a reference record.");
      assert(command.promotionProfileKey.trim().length > 0, "Reference promotion requires a profile key.");
      assert(command.promotionProfileVersion.trim().length > 0, "Reference promotion requires a profile version.");
      assert(command.promotionPlanFingerprint.trim().length > 0, "Reference promotion requires a plan fingerprint.");
      assertLaunchProfileMarker(command.promotionProfileKey, "Reference promotion profile key");
      assertLaunchProfileMarker(command.promotionProfileVersion, "Reference promotion profile version");
      assertLaunchProfileMarker(command.promotionPlanFingerprint, "Reference promotion plan fingerprint");

      return [
        {
          type: "catalog.source-observation.reference-promoted",
          data: {
            referenceRecordId: command.referenceRecordId.trim(),
            promotedAt: command.promotedAt,
            promotionProfileKey: normalizeKey(command.promotionProfileKey),
            promotionProfileVersion: command.promotionProfileVersion.trim(),
            promotionPlanFingerprint: command.promotionPlanFingerprint.trim(),
          },
        },
      ];
    case "RecordSourceObservationPromotionPlan":
      assert(state.id !== null, "Source observation must be recorded first.");
      assert(command.catalogItemId.trim().length > 0, "Promotion plan requires a catalog item.");
      assert(command.promotionProfileKey.trim().length > 0, "Promotion plan requires a profile key.");
      assert(command.promotionProfileVersion.trim().length > 0, "Promotion plan requires a profile version.");
      assert(command.promotionPlanFingerprint.trim().length > 0, "Promotion plan requires a fingerprint.");
      assertLaunchProfileMarker(command.promotionProfileKey, "Promotion plan profile key");
      assertLaunchProfileMarker(command.promotionProfileVersion, "Promotion plan profile version");
      assertLaunchProfileMarker(command.promotionPlanFingerprint, "Promotion plan fingerprint");

      return [
        {
          type: "catalog.source-observation.promotion-plan-recorded",
          data: {
            catalogItemId: command.catalogItemId.trim(),
            promotionProfileKey: normalizeKey(command.promotionProfileKey),
            promotionProfileVersion: command.promotionProfileVersion.trim(),
            promotionPlanFingerprint: command.promotionPlanFingerprint.trim(),
          },
        },
      ];
    case "RecordSourceObservationReferencePromotionPlan":
      assert(state.id !== null, "Source observation must be recorded first.");
      assert(command.referenceRecordId.trim().length > 0, "Reference promotion plan requires a reference record.");
      assert(command.promotionProfileKey.trim().length > 0, "Reference promotion plan requires a profile key.");
      assert(command.promotionProfileVersion.trim().length > 0, "Reference promotion plan requires a profile version.");
      assert(command.promotionPlanFingerprint.trim().length > 0, "Reference promotion plan requires a fingerprint.");
      assertLaunchProfileMarker(command.promotionProfileKey, "Reference promotion plan profile key");
      assertLaunchProfileMarker(command.promotionProfileVersion, "Reference promotion plan profile version");
      assertLaunchProfileMarker(command.promotionPlanFingerprint, "Reference promotion plan fingerprint");

      return [
        {
          type: "catalog.source-observation.reference-promotion-plan-recorded",
          data: {
            referenceRecordId: command.referenceRecordId.trim(),
            promotionProfileKey: normalizeKey(command.promotionProfileKey),
            promotionProfileVersion: command.promotionProfileVersion.trim(),
            promotionPlanFingerprint: command.promotionPlanFingerprint.trim(),
          },
        },
      ];
    case "RejectSourceObservation":
      requireObserved(state);
      assert(command.reason.trim().length > 0, "Rejection requires a reason.");

      return [
        {
          type: "catalog.source-observation.rejected",
          data: {
            reason: command.reason.trim(),
          },
        },
      ];
    case "DeferSourceObservation":
      requireReviewable(state);
      assert(command.reason.trim().length > 0, "Deferral requires a reason.");

      return [
        {
          type: "catalog.source-observation.deferred",
          data: {
            reason: command.reason.trim(),
            deferredAt: command.deferredAt,
            reviewStatus: state.status,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveSourceObservation: AggregateEvolver<SourceObservationState, SourceObservationEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.source-observation.recorded":
      return {
        ...state,
        id: event.data.observationId,
        providerKey: event.data.providerKey,
        externalKey: event.data.externalKey,
        sourceUrl: event.data.sourceUrl,
        languageCode: event.data.languageCode,
        sourceRecordHash: event.data.sourceRecordHash,
        sourceUpdatedAt: event.data.sourceUpdatedAt,
        observedAt: event.data.observedAt,
        sourceProfileKey: sourceProfileKeyFromEvent(event.data),
        sourceProfileVersion: sourceProfileVersionFromEvent(event.data),
        sourceMappingFingerprint: sourceMappingFingerprintFromEvent(event.data),
        normalized: event.data.normalized,
        sourcePayload: event.data.sourcePayload,
        status: "observed",
        statusReason: null,
      };
    case "catalog.source-observation.changed":
      return {
        ...state,
        id: event.data.observationId,
        providerKey: event.data.providerKey,
        externalKey: event.data.externalKey,
        sourceUrl: event.data.sourceUrl,
        languageCode: event.data.languageCode,
        sourceRecordHash: event.data.sourceRecordHash,
        sourceUpdatedAt: event.data.sourceUpdatedAt,
        observedAt: event.data.observedAt,
        sourceProfileKey: sourceProfileKeyFromEvent(event.data),
        sourceProfileVersion: sourceProfileVersionFromEvent(event.data),
        sourceMappingFingerprint: sourceMappingFingerprintFromEvent(event.data),
        normalized: event.data.normalized,
        sourcePayload: event.data.sourcePayload,
        status: "changed",
        statusReason: null,
      };
    case "catalog.source-observation.refreshed":
      return {
        ...state,
        id: event.data.observationId,
        providerKey: event.data.providerKey,
        externalKey: event.data.externalKey,
        sourceUrl: event.data.sourceUrl,
        languageCode: event.data.languageCode,
        sourceRecordHash: event.data.sourceRecordHash,
        sourceUpdatedAt: event.data.sourceUpdatedAt,
        observedAt: event.data.observedAt,
        sourceProfileKey: sourceProfileKeyFromEvent(event.data),
        sourceProfileVersion: sourceProfileVersionFromEvent(event.data),
        sourceMappingFingerprint: sourceMappingFingerprintFromEvent(event.data),
        normalized: event.data.normalized,
        sourcePayload: event.data.sourcePayload,
        status: event.data.status,
        statusReason: event.data.statusReason,
        promotedCatalogItemId: event.data.promotedCatalogItemId,
        promotedReferenceRecordId: event.data.promotedReferenceRecordId ?? null,
        promotedAt: event.data.promotedAt,
        promotionProfileKey: event.data.promotionProfileKey,
        promotionProfileVersion: event.data.promotionProfileVersion,
        promotionPlanFingerprint: event.data.promotionPlanFingerprint,
      };
    case "catalog.source-observation.promoted":
      return {
        ...state,
        status: "promoted",
        promotedCatalogItemId: event.data.catalogItemId,
        promotedReferenceRecordId: null,
        promotedAt: event.data.promotedAt,
        promotionProfileKey: promotionProfileKeyFromEvent(event.data),
        promotionProfileVersion: promotionProfileVersionFromEvent(event.data),
        promotionPlanFingerprint: promotionPlanFingerprintFromEvent(event.data),
      };
    case "catalog.source-observation.reference-promoted":
      return {
        ...state,
        status: "promoted",
        promotedCatalogItemId: null,
        promotedReferenceRecordId: event.data.referenceRecordId,
        promotedAt: event.data.promotedAt,
        promotionProfileKey: promotionProfileKeyFromEvent(event.data),
        promotionProfileVersion: promotionProfileVersionFromEvent(event.data),
        promotionPlanFingerprint: promotionPlanFingerprintFromEvent(event.data),
      };
    case "catalog.source-observation.promotion-plan-recorded":
      return {
        ...state,
        promotedCatalogItemId: event.data.catalogItemId,
        promotedReferenceRecordId: null,
        promotionProfileKey: event.data.promotionProfileKey,
        promotionProfileVersion: event.data.promotionProfileVersion,
        promotionPlanFingerprint: event.data.promotionPlanFingerprint,
      };
    case "catalog.source-observation.reference-promotion-plan-recorded":
      return {
        ...state,
        promotedCatalogItemId: null,
        promotedReferenceRecordId: event.data.referenceRecordId,
        promotionProfileKey: event.data.promotionProfileKey,
        promotionProfileVersion: event.data.promotionProfileVersion,
        promotionPlanFingerprint: event.data.promotionPlanFingerprint,
      };
    case "catalog.source-observation.rejected":
      return {
        ...state,
        status: "rejected",
        statusReason: event.data.reason,
      };
    case "catalog.source-observation.deferred":
      return {
        ...state,
        status: event.data.reviewStatus,
        statusReason: event.data.reason,
      };
    default:
      return assertNever(event);
  }
};

function requireObserved(state: SourceObservationState): void {
  assert(state.id !== null, "Source observation must be recorded first.");
  assert(state.status === "observed", "Only observed source observations can transition.");
}

function requirePromotable(state: SourceObservationState): void {
  assert(state.id !== null, "Source observation must be recorded first.");
  assert(
    state.status === "observed" || state.status === "changed",
    "Only observed or changed source observations can be promoted.",
  );
}

function requireReviewable(state: SourceObservationState): asserts state is SourceObservationState & {
  status: "observed" | "changed";
} {
  assert(state.id !== null, "Source observation must be recorded first.");
  assert(
    state.status === "observed" || state.status === "changed",
    "Only observed or changed source observations can be deferred.",
  );
}

function recordEventData(command: RecordSourceObservationCommand): SourceObservationRecordEventData {
  return {
    observationId: command.observationId,
    providerKey: normalizeKey(command.providerKey),
    externalKey: command.externalKey.trim(),
    sourceUrl: command.sourceUrl.trim(),
    languageCode: normalizeKey(command.languageCode),
    sourceRecordHash: command.sourceRecordHash,
    sourceUpdatedAt: command.sourceUpdatedAt ?? null,
    observedAt: command.observedAt,
    sourceProfileKey: normalizeKey(command.sourceProfileKey),
    sourceProfileVersion: command.sourceProfileVersion.trim(),
    sourceMappingFingerprint: command.sourceMappingFingerprint.trim(),
    normalized: command.normalized,
    sourcePayload: command.sourcePayload,
  };
}

function sourceProfileKeyFromEvent(data: { sourceProfileKey?: string }): string {
  return requireLaunchProfileMarker(data.sourceProfileKey, "Source observation source profile key").toLowerCase();
}

function sourceProfileVersionFromEvent(data: { sourceProfileVersion?: string }): string {
  return requireLaunchProfileMarker(data.sourceProfileVersion, "Source observation source profile version");
}

function sourceMappingFingerprintFromEvent(data: { sourceMappingFingerprint?: string }): string {
  return requireLaunchProfileMarker(data.sourceMappingFingerprint, "Source observation source mapping fingerprint");
}

function promotionProfileKeyFromEvent(data: { promotionProfileKey?: string }): string {
  return requireLaunchProfileMarker(data.promotionProfileKey, "Promotion profile key").toLowerCase();
}

function promotionProfileVersionFromEvent(data: { promotionProfileVersion?: string }): string {
  return requireLaunchProfileMarker(data.promotionProfileVersion, "Promotion profile version");
}

function promotionPlanFingerprintFromEvent(data: { promotionPlanFingerprint?: string }): string {
  return requireLaunchProfileMarker(data.promotionPlanFingerprint, "Promotion plan fingerprint");
}

function assertLaunchProfileMarker(value: string, label: string): void {
  requireLaunchProfileMarker(value, label);
}

function requireLaunchProfileMarker(value: string | null | undefined, label: string): string {
  const marker = value?.trim();
  assert(marker !== undefined && marker.length > 0, `${label} is required.`);
  assert(marker.toLowerCase() !== "legacy", `${label} cannot use the retired legacy marker.`);
  return marker;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
