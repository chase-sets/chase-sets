import { isDeepStrictEqual } from "node:util";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
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
import tcgdexBase260ScenarioFixture from "../__fixtures__/tcgdex/base2-60-scenario.json" with { type: "json" };
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
const promotedSeedLifecycle = ["catalog.source-observation.recorded", "catalog.source-observation.promoted"] as const;
// One refresh is the seed's only reconciliation append, so a reconciled stream keeps a fixed shape.
const reconciledPromotedSeedLifecycle = [...promotedSeedLifecycle, "catalog.source-observation.refreshed"] as const;

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
  const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(services.db);
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

  if (isExactLifecycle(eventTypes, promotedSeedLifecycle)) {
    await reconcileOrRefusePromotedSeedHistory(services, evidence.recordCommand, state, expectedPromotedState);
    return;
  }

  if (isExactLifecycle(eventTypes, reconciledPromotedSeedLifecycle)) {
    requireSeedState("reconciled promoted", state, expectedPromotedState);
    return;
  }

  throw new Error(
    `Catalog browser Source Observation seed cannot reconcile lifecycle '${eventTypes.join(" -> ") || "empty"}'.`,
  );
}

/**
 * The promotion plan is validated against `db`: the seed passes the scenario
 * database so the refresh plan resolves the exact Pikachu Jungle target's
 * display identity; database-free tests pass a clearly synthetic queryable.
 */
export async function buildCatalogBrowserE2ePromotedObservationSeedEvidence(
  db: PgQueryable,
): Promise<CatalogBrowserE2ePromotedObservationSeedEvidence> {
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
  const promotionPlanResult = await planCatalogProviderPromotionCommands({
    db,
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

/**
 * A long-lived environment holds a promoted stream written by an older fixture revision.
 * The seed reconciles that drift only when replaying the fixture's record command against the
 * stored stream provably lands on the expected state through a single refresh — the one event
 * that carries the existing promotion forward instead of promoting again. Every other shape of
 * drift is refused with the field path that diverged, so drift is never repaired silently.
 */
async function reconcileOrRefusePromotedSeedHistory(
  services: CatalogServices,
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>,
  actual: SourceObservationState,
  expected: SourceObservationState,
): Promise<void> {
  const divergentFieldPath = diagnoseSeedStateDivergence(actual, expected);
  if (divergentFieldPath === null) {
    return;
  }

  const refreshed = refreshedSeedState(recordCommand, actual);
  if (refreshed === null || diagnoseSeedStateDivergence(refreshed, expected) !== null) {
    throw seedStateMismatch("promoted", divergentFieldPath, actual, expected);
  }

  await sendSeedCommand(services.sourceObservations.commandHandler, sourceObservationStreamId, recordCommand);
}

function refreshedSeedState(
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>,
  state: SourceObservationState,
): SourceObservationState | null {
  let events: readonly SourceObservationEvent[];
  try {
    events = decideSourceObservation(state, recordCommand);
  } catch {
    return null;
  }

  const [event] = events;
  if (events.length !== 1 || event?.type !== "catalog.source-observation.refreshed") {
    return null;
  }
  return evolveSourceObservation(state, event);
}

function requireSeedState(label: string, actual: SourceObservationState, expected: SourceObservationState): void {
  const divergentFieldPath = diagnoseSeedStateDivergence(actual, expected);
  if (divergentFieldPath !== null) {
    throw seedStateMismatch(label, divergentFieldPath, actual, expected);
  }
}

function seedStateMismatch(label: string, divergentFieldPath: string, actual: unknown, expected: unknown): Error {
  const divergence = seedStateDivergence(actual, expected);
  const scalarValues = divergence && isSeedScalar(divergence.actual) && isSeedScalar(divergence.expected)
    ? ` (expected ${boundedSeedScalar(divergence.expected)}, actual ${boundedSeedScalar(divergence.actual)})`
    : "";
  return new Error(
    `Catalog browser Source Observation seed found ${label} history with mismatched identity, facts, target, profile, terminal state, or fingerprint at field path '${divergentFieldPath}'${scalarValues}.`,
  );
}

function isSeedScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function boundedSeedScalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  const limit = 96;
  return `${JSON.stringify(value.slice(0, limit))}${value.length > limit ? "[truncated]" : ""}`;
}

/**
 * Names the first field path where a rehydrated history diverges from the fixture's expected
 * state, or null when the two match. The accept/reject decision stays the strict whole-value
 * `isDeepStrictEqual`; the walk below only runs once that comparison has already rejected.
 */
export function diagnoseSeedStateDivergence(actual: unknown, expected: unknown, path = ""): string | null {
  return seedStateDivergence(actual, expected, path)?.path ?? null;
}

function seedStateDivergence(
  actual: unknown,
  expected: unknown,
  path = "",
): Readonly<{ path: string; actual: unknown; expected: unknown }> | null {
  if (isDeepStrictEqual(actual, expected)) {
    return null;
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
      const nested = seedStateDivergence(actual[index], expected[index], `${path}[${index}]`);
      if (nested !== null) {
        return nested;
      }
    }
    return { path: path || "<root>", actual, expected };
  }

  if (isFieldRecord(actual) && isFieldRecord(expected)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const nested = seedStateDivergence(actual[key], expected[key], path ? `${path}.${key}` : key);
      if (nested !== null) {
        return nested;
      }
    }
    return { path: path || "<root>", actual, expected };
  }

  return { path: path || "<root>", actual, expected };
}

function isFieldRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
