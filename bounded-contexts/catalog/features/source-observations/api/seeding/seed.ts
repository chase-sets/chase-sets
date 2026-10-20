import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId, ReferenceRecordId } from "../../../../ids";
import type { CatalogServices } from "../../../../support/authoring-support/services";
import { seedContext, sendSeedCommand } from "../../../../support/seed-support/context";
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

export const catalogBrowserE2eChangedObservation = {
  observationId: "tcgdex_en_base2_60_1st_edition",
  displayName: "Pikachu",
} as const;

const sourceObservationStreamId =
  `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}` as const;
const changedSourceObservationStreamId =
  `catalog.source-observation-${catalogBrowserE2eChangedObservation.observationId}` as const;
const tcgdexSourceObservationStreamPrefix = "catalog.source-observation-tcgdex_";
const promotedAt = "2026-06-03T00:01:00.000Z";
const observedAt = "2026-06-03T00:00:00.000Z";
const changedRevisionObservedAt = "2026-06-10T09:00:00.000Z";
type TcgdexScenarioCard = typeof tcgdexBase260ScenarioFixture.card;
// TCGdex later re-published the scenario card; the newer revision timestamp is its only difference.
const changedRevisionCard: TcgdexScenarioCard = {
  ...tcgdexBase260ScenarioFixture.card,
  updated: "2026-06-10T09:00:00+01:00",
};
const promotedSeedLifecycle = ["catalog.source-observation.recorded", "catalog.source-observation.promoted"] as const;
const changedSeedLifecycle = [...promotedSeedLifecycle, "catalog.source-observation.changed"] as const;
// One refresh is the seed's only reconciliation append, so a reconciled stream keeps a fixed shape.
const reconciledPromotedSeedLifecycle = [...promotedSeedLifecycle, "catalog.source-observation.refreshed"] as const;
const migratedPromotedSeedLifecycle = [
  ...promotedSeedLifecycle,
  "catalog.source-observation.promotion-plan-recorded",
] as const;
const historicalPlanFingerprint = "f0d75b34e937923016ba19fad5b9b611e101d8e31b8cbe2176e26aadaf4de599";
const migratedPlanFingerprint = "9ec3a12b68c7f1945da0089934ddc97ccc956d5a799c98d2cb8d9c61614ad90c";

type StoredSourceObservationEvent = Readonly<{
  event_type: string;
  payload: JsonValue;
  stream_version: number;
}>;

export type CatalogBrowserE2ePromotedObservationSeedEvidence = Readonly<{
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>;
  promotionCommand: Extract<SourceObservationCommand, { type: "PromoteSourceObservation" }>;
  promotionPlan: CatalogProviderPromotionCommandPlan;
}>;

export type CatalogBrowserE2eChangedObservationSeedEvidence = Readonly<{
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>;
  promotionCommand: Extract<SourceObservationCommand, { type: "PromoteSourceObservation" }>;
  changedRecordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>;
}>;

/**
 * Gives disposable scenario environments one stable promoted review row so the
 * browser journey can prove row-level reapply/replay wiring without a live provider pull.
 */
export async function seedPromotedSourceObservationScenario(services: CatalogServices): Promise<void> {
  await requireExactPromotionTarget(services);
  const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(services.db);
  const existing = await loadSeedHistory(services.db, sourceObservationStreamId);
  const state = rehydrateSeedHistory(existing);
  const expectedRecordedState = expectedStateAfter(evidence.recordCommand, initialSourceObservationState);
  const expectedPromotedState = expectedStateAfter(evidence.promotionCommand, expectedRecordedState);

  if (existing.length === 0) {
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

  const eventTypes = existing.map((row) => row.event_type);
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
    if (state.promotionPlanFingerprint === historicalPlanFingerprint) {
      await migrateHistoricalSeedPlan(services, evidence, existing, state, expectedPromotedState);
      return;
    }
    await reconcileOrRefusePromotedSeedHistory(services, evidence.recordCommand, state, expectedPromotedState);
    return;
  }

  if (isExactLifecycle(eventTypes, migratedPromotedSeedLifecycle)) {
    await migrateHistoricalSeedPlan(services, evidence, existing, state, expectedPromotedState);
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
 * Gives the browser journey its one selectable changed review row: the scenario
 * card's 1st Edition observation was recorded and promoted, then a newer TCGdex
 * revision changed it. The authoritative stream must be an exact prefix of those
 * three events; the seed appends only the missing suffix at the verified stream
 * version and refuses every other history instead of repairing it.
 */
export async function seedChangedSourceObservationScenario(services: CatalogServices): Promise<void> {
  await requireExactPromotionTarget(services);
  const evidence = await buildCatalogBrowserE2eChangedObservationSeedEvidence(services.db);
  const commands = [evidence.recordCommand, evidence.promotionCommand, evidence.changedRecordCommand];
  // The exact events these commands write when replayed in order from an empty stream.
  let expectedState = initialSourceObservationState;
  const expectedEvents = commands.map((command) => {
    const event = decideSeedEvent(command, expectedState);
    expectedState = evolveSourceObservation(expectedState, event);
    return event;
  });
  const expectedLifecycle = expectedEvents.map((event) => event.type);
  if (!isExactLifecycle(expectedLifecycle, changedSeedLifecycle)) {
    throw new Error("Catalog browser changed Source Observation fixture must decide recorded -> promoted -> changed.");
  }

  const existing = await loadSeedHistory(services.db, changedSourceObservationStreamId);
  if (existing.length > expectedEvents.length) {
    throw new Error(
      `Catalog browser changed Source Observation seed cannot reconcile lifecycle '${existing
        .map((row) => row.event_type)
        .join(" -> ")}'.`,
    );
  }
  for (const [index, row] of existing.entries()) {
    requireExactSeedEvent("changed history", row, expectedEvents[index], index + 1);
  }

  for (let version = existing.length; version < commands.length; version += 1) {
    await services.sourceObservations.commandHandler({
      streamId: changedSourceObservationStreamId,
      command: commands[version],
      context: seedContext,
      expectedVersion: version,
    });
  }
  await logScenarioSourceObservationEvidence(services.db);
}

export async function buildCatalogBrowserE2ePromotedObservationSeedEvidence(
  db: PgQueryable,
): Promise<CatalogBrowserE2ePromotedObservationSeedEvidence> {
  const observation = await scenarioSourceObservation(
    catalogBrowserE2ePromotedObservation.observationId,
    tcgdexBase260ScenarioFixture.card,
    observedAt,
  );
  return { recordCommand: toRecordCommand(observation), ...(await scenarioPromotion(db, observation)) };
}

export async function buildCatalogBrowserE2eChangedObservationSeedEvidence(
  db: PgQueryable,
): Promise<CatalogBrowserE2eChangedObservationSeedEvidence> {
  const { observationId } = catalogBrowserE2eChangedObservation;
  const observation = await scenarioSourceObservation(observationId, tcgdexBase260ScenarioFixture.card, observedAt);
  const changedRevision = await scenarioSourceObservation(
    observationId,
    changedRevisionCard,
    changedRevisionObservedAt,
  );
  const { promotionCommand } = await scenarioPromotion(db, observation);
  return {
    recordCommand: toRecordCommand(observation),
    promotionCommand,
    changedRecordCommand: toRecordCommand(changedRevision),
  };
}

async function scenarioSourceObservation(
  observationId: string,
  card: TcgdexScenarioCard,
  revisionObservedAt: string,
): Promise<CatalogProviderSourceObservationInput> {
  const payloads = await fetchTcgdexSetObservationPayloads({
    profile: tcgdexPokemonTcgProviderProfile,
    languageCode: "en",
    setId: "base2",
    observedAt: revisionObservedAt,
    fetch: tcgdexScenarioFixtureFetch(card),
  });
  const payload = payloads.find((candidate) => candidate.payload.observationId === observationId);
  if (!payload) {
    throw new Error(`Catalog browser TCGdex fixture did not produce the required '${observationId}' observation.`);
  }

  return requireCatalogProviderSourceObservation({
    contract: tcgdexPokemonCardSourceObservationMappingContract,
    payload: payload.payload,
    observedAt: payload.observedAt,
  });
}

/**
 * The promotion plan is validated against `db`: the seed passes the scenario
 * database so the refresh plan resolves the exact Pikachu Jungle target's
 * display identity; database-free tests pass a clearly synthetic queryable.
 */
async function scenarioPromotion(
  db: PgQueryable,
  observation: CatalogProviderSourceObservationInput,
): Promise<Omit<CatalogBrowserE2ePromotedObservationSeedEvidence, "recordCommand">> {
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

/** One append-only migration of the scenario's historical seven-input plan contract, not reconciliation. */
async function migrateHistoricalSeedPlan(
  services: CatalogServices,
  evidence: CatalogBrowserE2ePromotedObservationSeedEvidence,
  rows: readonly StoredSourceObservationEvent[],
  actual: SourceObservationState,
  expected: SourceObservationState,
): Promise<void> {
  const plan = evidence.promotionPlan;
  // Recompute the seven original inputs from the freshly validated plan. The
  // successor adds only the validated display identity and explicit draft choice.
  const historicalInputs = {
    providerKey: plan.providerKey,
    profileKey: plan.profileKey,
    profileVersion: plan.profileVersion,
    mappingKind: plan.mappingKind,
    mode: plan.mode,
    commands: plan.commands,
    productContents: plan.productContents ?? null,
  };
  const recomputedHistorical = createHash("sha256").update(historicalPlanJson(historicalInputs)).digest("hex");
  if (recomputedHistorical !== historicalPlanFingerprint || plan.planFingerprint !== migratedPlanFingerprint) {
    throw new Error(
      "Catalog browser Source Observation seed plan is outside the allowlisted historical contract migration.",
    );
  }

  const recorded = expectedStateAfter(evidence.recordCommand, initialSourceObservationState);
  const historicalPromotion = { ...evidence.promotionCommand, promotionPlanFingerprint: historicalPlanFingerprint };
  const predecessor = expectedStateAfter(historicalPromotion, recorded);
  const predecessorEvents = [
    decideSourceObservation(initialSourceObservationState, evidence.recordCommand)[0],
    decideSourceObservation(recorded, historicalPromotion)[0],
  ];
  requireSeedState("migration predecessor", rehydrateSeedHistory(rows.slice(0, 2)), predecessor);
  for (const [index, event] of predecessorEvents.entries()) {
    requireExactSeedEvent("migration", rows[index], event, index + 1);
  }

  const command: Extract<SourceObservationCommand, { type: "RecordSourceObservationPromotionPlan" }> = {
    type: "RecordSourceObservationPromotionPlan",
    catalogItemId: evidence.promotionCommand.catalogItemId,
    promotionProfileKey: evidence.promotionCommand.promotionProfileKey,
    promotionProfileVersion: evidence.promotionCommand.promotionProfileVersion,
    promotionPlanFingerprint: plan.planFingerprint,
  };
  const migrated = expectedStateAfter(command, predecessor);
  requireSeedState("migration result", migrated, expected);

  if (rows.length === 3) {
    requireExactSeedEvent("migration", rows[2], decideSourceObservation(predecessor, command)[0], 3);
    requireSeedState("migrated promoted", actual, expected);
    return;
  }

  requireSeedState("migration predecessor", actual, predecessor);
  await services.sourceObservations.commandHandler({
    streamId: sourceObservationStreamId,
    command,
    context: seedContext,
    expectedVersion: 2,
  });
}

function requireExactSeedEvent(
  label: string,
  actual: StoredSourceObservationEvent | undefined,
  expected: SourceObservationEvent,
  version: number,
): void {
  if (
    actual?.stream_version !== version ||
    actual.event_type !== expected.type ||
    !isDeepStrictEqual(actual.payload, expected.data)
  ) {
    const divergentFieldPath =
      actual?.event_type === expected.type ? diagnoseSeedStateDivergence(actual.payload, expected.data) : null;
    throw new Error(
      `Catalog browser Source Observation seed ${label} requires the exact event at version ${version}${
        divergentFieldPath ? ` (field path '${divergentFieldPath}')` : ""
      }.`,
    );
  }
}

// Exact historical stable JSON encoding (the planner's stableStringify before displayIdentity and promoteAsDraft joined the fingerprint), local to this bounded contract migration.
function historicalPlanJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(historicalPlanJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${historicalPlanJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

/**
 * The browser-e2e bootstrap's count-and-lifecycle record for the scenario Source
 * Observations, read back from the event store after the changed seed converges.
 */
async function logScenarioSourceObservationEvidence(db: PgQueryable): Promise<void> {
  const tcgdexStreams = await db.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM event_store_streams WHERE starts_with(stream_id, $1)",
    [tcgdexSourceObservationStreamPrefix],
  );
  const changedHistory = await loadSeedHistory(db, changedSourceObservationStreamId);
  console.log(
    JSON.stringify({
      event: "catalog-scenario-source-observations-seeded",
      tcgdexObservationCount: tcgdexStreams.rows[0]?.count ?? 0,
      changedObservationId: catalogBrowserE2eChangedObservation.observationId,
      changedObservationLifecycle: changedHistory.map((row) => row.event_type),
    }),
  );
}

async function loadSeedHistory(db: PgQueryable, streamId: string): Promise<readonly StoredSourceObservationEvent[]> {
  const history = await db.query<StoredSourceObservationEvent>(
    `SELECT event_type, payload, stream_version::integer AS stream_version
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version ASC`,
    [streamId],
  );
  return history.rows;
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
  return evolveSourceObservation(state, decideSeedEvent(command, state));
}

function decideSeedEvent(command: SourceObservationCommand, state: SourceObservationState): SourceObservationEvent {
  const events = decideSourceObservation(state, command);
  if (events.length !== 1) {
    throw new Error("Catalog browser Source Observation fixture must remain within one bounded record event.");
  }
  return events[0];
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
  const scalarValues =
    divergence && isSeedScalar(divergence.actual) && isSeedScalar(divergence.expected)
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

function tcgdexScenarioFixtureFetch(card: TcgdexScenarioCard): (input: RequestInfo | URL) => Promise<Response> {
  return (input) => {
    const url = String(input);
    const response = url.endsWith("/en/sets/base2")
      ? tcgdexBase260ScenarioFixture.set
      : url.endsWith("/en/cards/base2-60")
        ? card
        : null;

    return Promise.resolve(
      response
        ? new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(null, { status: 404 }),
    );
  };
}
