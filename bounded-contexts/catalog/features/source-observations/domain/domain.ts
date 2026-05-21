import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import { assert, assertNever } from "../../../support/runtime-support/common";

export type SourceObservationStatus = "observed" | "changed" | "promoted" | "rejected";

export type SourceObservationNormalized = JsonObject &
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
  }>;

export type SourceObservationState = Readonly<{
  id: string | null;
  providerKey: string;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string | null;
  normalized: SourceObservationNormalized | null;
  sourcePayload: JsonValue;
  status: SourceObservationStatus;
  statusReason: string | null;
  promotedCatalogItemId: string | null;
  promotedAt: string | null;
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
  normalized: null,
  sourcePayload: null,
  status: "observed",
  statusReason: null,
  promotedCatalogItemId: null,
  promotedAt: null,
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
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
}>;

export type PromoteSourceObservationCommand = Readonly<{
  type: "PromoteSourceObservation";
  catalogItemId: string;
  promotedAt: string;
}>;

export type RejectSourceObservationCommand = Readonly<{
  type: "RejectSourceObservation";
  reason: string;
}>;

export type SourceObservationCommand =
  | RecordSourceObservationCommand
  | PromoteSourceObservationCommand
  | RejectSourceObservationCommand;

export type SourceObservationRecordedEvent = DomainEvent<
  "catalog.source-observation.recorded",
  JsonObject &
    Omit<RecordSourceObservationCommand, "type" | "sourceUpdatedAt"> &
    Readonly<{ sourceUpdatedAt: string | null }>
>;

export type SourceObservationChangedEvent = DomainEvent<
  "catalog.source-observation.changed",
  JsonObject &
    Omit<RecordSourceObservationCommand, "type" | "sourceUpdatedAt"> &
    Readonly<{ sourceUpdatedAt: string | null }>
>;

export type SourceObservationPromotedEvent = DomainEvent<
  "catalog.source-observation.promoted",
  Readonly<{
    catalogItemId: string;
    promotedAt: string;
  }>
>;

export type SourceObservationRejectedEvent = DomainEvent<
  "catalog.source-observation.rejected",
  Readonly<{
    reason: string;
  }>
>;

export type SourceObservationEvent =
  | SourceObservationRecordedEvent
  | SourceObservationChangedEvent
  | SourceObservationPromotedEvent
  | SourceObservationRejectedEvent;

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

      if (state.id !== null) {
        if (
          state.sourceRecordHash === command.sourceRecordHash &&
          state.sourceUpdatedAt === (command.sourceUpdatedAt ?? null)
        ) {
          return [];
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

      return [
        {
          type: "catalog.source-observation.promoted",
          data: {
            catalogItemId: command.catalogItemId.trim(),
            promotedAt: command.promotedAt,
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
        normalized: event.data.normalized,
        sourcePayload: event.data.sourcePayload,
        status: "changed",
        statusReason: null,
      };
    case "catalog.source-observation.promoted":
      return {
        ...state,
        status: "promoted",
        promotedCatalogItemId: event.data.catalogItemId,
        promotedAt: event.data.promotedAt,
      };
    case "catalog.source-observation.rejected":
      return {
        ...state,
        status: "rejected",
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

function recordEventData(command: RecordSourceObservationCommand): SourceObservationRecordedEvent["data"] {
  return {
    observationId: command.observationId,
    providerKey: normalizeKey(command.providerKey),
    externalKey: command.externalKey.trim(),
    sourceUrl: command.sourceUrl.trim(),
    languageCode: normalizeKey(command.languageCode),
    sourceRecordHash: command.sourceRecordHash,
    sourceUpdatedAt: command.sourceUpdatedAt ?? null,
    observedAt: command.observedAt,
    normalized: command.normalized,
    sourcePayload: command.sourcePayload,
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
