import { isDeepStrictEqual } from "node:util";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId, ReferenceRecordId } from "../../../../ids";
import type { CatalogServices } from "../../../../support/authoring-support/services";
import { sendSeedCommand } from "../../../../support/seed-support/context";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../../domain/domain";
import tcgdexBase260ScenarioFixture from "../__fixtures__/tcgdex/base2-60-scenario.json";
import { tcgdexPokemonTcgProviderProfile } from "../provider-integration-profiles";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionCommandPlan,
} from "../promotion/provider-promotion-command-planner";
import {
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationInput,
} from "../promotion/provider-source-observation-normalizer";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../tcgdex-executable-mapping-contract";
import { fetchTcgdexSetObservationPayloads } from "../providers/tcgdex-client";

export const catalogBrowserE2ePromotedObservation = {
  observationId: "tcgdex_en_base2_60",
  displayName: "Pikachu",
} as const;

const sourceObservationStreamId =
  `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}` as const;
const promotedAt = "2026-06-03T00:01:00.000Z";
const observedAt = "2026-06-03T00:00:00.000Z";

type StoredSourceObservationEvent = Readonly<{
  event_type: string;
  payload: JsonValue;
}>;

export type CatalogBrowserE2ePromotedObservationSeedEvidence = Readonly<{
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>;
  promotionCommand: Extract<SourceObservationCommand, { type: "PromoteSourceObservation" }>;
  promotionPlan: CatalogProviderPromotionCommandPlan;
}>;

/**
 * Gives disposable scenario environments one stable promoted review row so the
 * browser journey can prove row-level reapply/replay wiring without a live provider pull.
 */
export async function seedPromotedSourceObservationScenario(services: CatalogServices): Promise<void> {
  await requireExactPromotionTarget(services);
  const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence();
  const existing = await services.db.query<StoredSourceObservationEvent>(
    `SELECT event_type, payload
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version ASC`,
    [sourceObservationStreamId],
  );
  const state = rehydrateSeedHistory(existing.rows);
  const expectedRecordedState = expectedStateAfter(evidence.recordCommand, initialSourceObservationState);
  const expectedPromotedState = expectedStateAfter(evidence.promotionCommand, expectedRecordedState);

  if (existing.rows.length === 0) {
    await sendSeedCommand(
      services.sourceObservations.commandHandler,
      sourceObservationStreamId,
      evidence.recordCommand,
    );
    await sendSeedCommand(
      services.sourceObservations.commandHandler,
      sourceObservationStreamId,
      evidence.promotionCommand,
    );
    return;
  }

  const eventTypes = existing.rows.map((row) => row.event_type);
  if (isExactLifecycle(eventTypes, ["catalog.source-observation.recorded"])) {
    requireSeedState("recorded-only", state, expectedRecordedState);
    await sendSeedCommand(
      services.sourceObservations.commandHandler,
      sourceObservationStreamId,
      evidence.promotionCommand,
    );
    return;
  }

  if (isExactLifecycle(eventTypes, ["catalog.source-observation.recorded", "catalog.source-observation.promoted"])) {
    requireSeedState("promoted", state, expectedPromotedState);
    return;
  }

  throw new Error(
    `Catalog browser Source Observation seed cannot reconcile lifecycle '${eventTypes.join(" -> ") || "empty"}'.`,
  );
}

export async function buildCatalogBrowserE2ePromotedObservationSeedEvidence(): Promise<CatalogBrowserE2ePromotedObservationSeedEvidence> {
  const payloads = await fetchTcgdexSetObservationPayloads({
    profile: tcgdexPokemonTcgProviderProfile,
    languageCode: "en",
    setId: "base2",
    observedAt,
    fetch: fetchTcgdexScenarioFixture,
  });
  const payload = payloads.find(
    (candidate) => candidate.payload.observationId === catalogBrowserE2ePromotedObservation.observationId,
  );
  if (!payload) {
    throw new Error("Catalog browser TCGdex fixture did not produce the required standard Pikachu observation.");
  }

  const observation = requireCatalogProviderSourceObservation({
    contract: tcgdexPokemonCardSourceObservationMappingContract,
    payload: payload.payload,
    observedAt: payload.observedAt,
  });
  const promotionPlanResult = planCatalogProviderPromotionCommands({
    profile: tcgdexPokemonTcgProviderProfile,
    profileKey: tcgdexPokemonCardSourceObservationMappingContract.profileKey,
    profileVersion: tcgdexPokemonCardSourceObservationMappingContract.profileVersion,
    providerKey: observation.providerKey,
    externalKey: observation.externalKey,
    mode: "refresh",
    catalogItemId: catalogSeedIds.items.pikachuJungle as CatalogItemId,
    normalized: observation.normalized,
    catalog: scenarioPromotionCatalogMapping(),
    expansionReferenceId: catalogSeedIds.referenceRecords.expansions.jungle as ReferenceRecordId,
    metadata: { title: observation.normalized.name, subtitle: "" },
    productAssetSet: null,
    preflight: { status: "ready" },
  });
  if (promotionPlanResult.status !== "planned") {
    throw new Error(
      `Catalog browser TCGdex fixture promotion plan is blocked: ${promotionPlanResult.diagnostics
        .map((diagnostic) => diagnostic.diagnosticText)
        .join("; ")}`,
    );
  }

  return {
    recordCommand: toRecordCommand(observation),
    promotionCommand: {
      type: "PromoteSourceObservation",
      catalogItemId: catalogSeedIds.items.pikachuJungle,
      promotedAt,
      promotionProfileKey: tcgdexPokemonCardSourceObservationMappingContract.profileKey,
      promotionProfileVersion: tcgdexPokemonCardSourceObservationMappingContract.profileVersion,
      promotionPlanFingerprint: promotionPlanResult.plan.planFingerprint,
    },
    promotionPlan: promotionPlanResult.plan,
  };
}

async function requireExactPromotionTarget(services: CatalogServices): Promise<void> {
  const targetStreamId = `catalog.item-${catalogSeedIds.items.pikachuJungle}`;
  const target = await services.db.query<{
    stream_created: boolean;
    stream_published: boolean;
    projection_active: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM event_store_events
         WHERE stream_id = $1 AND event_type = 'catalog.catalog-item.created'
       ) AS stream_created,
       EXISTS (
         SELECT 1 FROM event_store_events
         WHERE stream_id = $1 AND event_type = 'catalog.catalog-item.published'
       ) AS stream_published,
       EXISTS (
         SELECT 1 FROM catalog_items
         WHERE catalog_item_id = $2 AND status = 'active'
       ) AS projection_active`,
    [targetStreamId, catalogSeedIds.items.pikachuJungle],
  );
  const row = target.rows[0];
  if (!row?.stream_created || !row.stream_published || !row.projection_active) {
    throw new Error(
      `Catalog browser Source Observation seed requires active Catalog Item '${catalogSeedIds.items.pikachuJungle}' in its exact event stream and projection.`,
    );
  }
}

function rehydrateSeedHistory(rows: readonly StoredSourceObservationEvent[]): SourceObservationState {
  let state = initialSourceObservationState;
  for (const [index, row] of rows.entries()) {
    const event = sourceObservationEvent(row);
    try {
      state = evolveSourceObservation(state, event);
    } catch (error) {
      throw new Error(
        `Catalog browser Source Observation seed cannot rehydrate event ${index + 1} '${row.event_type}': ${
          error instanceof Error ? error.message : "invalid event"
        }`,
      );
    }
  }
  return state;
}

function sourceObservationEvent(row: StoredSourceObservationEvent): SourceObservationEvent {
  switch (row.event_type) {
    case "catalog.source-observation.recorded":
    case "catalog.source-observation.changed":
    case "catalog.source-observation.refreshed":
    case "catalog.source-observation.source-payload-chunk-recorded":
    case "catalog.source-observation.promoted":
    case "catalog.source-observation.reference-promoted":
    case "catalog.source-observation.promotion-plan-recorded":
    case "catalog.source-observation.reference-promotion-plan-recorded":
    case "catalog.source-observation.rejected":
    case "catalog.source-observation.deferred":
      return { type: row.event_type, data: row.payload } as SourceObservationEvent;
    default:
      throw new Error(`Catalog browser Source Observation seed found unexpected event '${row.event_type}'.`);
  }
}

function expectedStateAfter(command: SourceObservationCommand, state: SourceObservationState): SourceObservationState {
  const events = decideSourceObservation(state, command);
  if (events.length !== 1) {
    throw new Error("Catalog browser Source Observation fixture must remain within one bounded record event.");
  }
  return evolveSourceObservation(state, events[0]);
}

function requireSeedState(label: string, actual: SourceObservationState, expected: SourceObservationState): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Catalog browser Source Observation seed found ${label} history with mismatched identity, facts, target, profile, terminal state, or fingerprint.`,
    );
  }
}

function isExactLifecycle(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((eventType, index) => eventType === expected[index]);
}

function toRecordCommand(
  observation: CatalogProviderSourceObservationInput,
): Extract<SourceObservationCommand, { type: "RecordSourceObservation" }> {
  return { type: "RecordSourceObservation", ...observation };
}

function scenarioPromotionCatalogMapping() {
  return {
    blueprintId: catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId,
    categoryId: catalogSeedIds.categories.singles as CategoryId,
    fieldIds: {
      cardNumber: catalogSeedIds.fields.cardNumber as FieldId,
      cardName: catalogSeedIds.fields.cardName as FieldId,
      expansion: catalogSeedIds.fields.expansion as FieldId,
      rarity: catalogSeedIds.fields.rarity as FieldId,
      cardVariant: catalogSeedIds.fields.cardVariant as FieldId,
      cardIllustrator: catalogSeedIds.fields.cardIllustrator as FieldId,
      releaseYear: catalogSeedIds.fields.releaseYear as FieldId,
    },
  };
}

function fetchTcgdexScenarioFixture(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const response = url.endsWith("/en/sets/base2")
    ? tcgdexBase260ScenarioFixture.set
    : url.endsWith("/en/cards/base2-60")
      ? tcgdexBase260ScenarioFixture.card
      : null;

  return Promise.resolve(
    response
      ? new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(null, { status: 404 }),
  );
}
