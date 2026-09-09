import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { ChannelListingIdDigest } from "../domain/canonical";
import {
  assertChannelMappingCandidatesPayload,
  assertChannelMappingDecisionCommandPayload,
  assertChannelPublicationOutcomePayload,
  assertChannelPublicationSettingsPayload,
  channelListingEventCodec,
  channelListingReconciliationEventCodec,
  channelPublicationConfigurationEventCodec,
} from "../domain/codecs";
import {
  decideChannelMappingReview,
  decideRecordChannelMappingCandidates,
  decideReplaceChannelPublicationSettings,
  evolveChannelPublicationConfiguration,
  initialChannelPublicationConfigurationState,
  type ChannelMappingCandidate,
  type ChannelPublicationConfigurationEvent,
  type ChannelPublicationConfigurationState,
  type ConfigurationDecision,
} from "../domain/configuration";
import type {
  ChannelCommandResult,
  ChannelCompositionProfileRegistry,
  ChannelMappingDimension,
  ChannelMappingReviewPage,
  ChannelPublicationConnectionDetail,
  ChannelPublicationConnectionSummary,
  ChannelPublicationOutcome,
  ChannelPublicationSettings,
  ChannelReferenceRead,
} from "../domain/contracts";
import {
  decideChannelListingPublicationOutcome,
  evolveChannelListing,
  initialChannelListingAggregateState,
  type ChannelListingAggregateState,
} from "../domain/link";
import {
  evolveChannelListingReconciliation,
  initialChannelListingReconciliationState,
  type ChannelListingReconciliationEvent,
  type ChannelListingReconciliationScope,
  type ChannelListingReconciliationState,
} from "../domain/reconciliation";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelConnectionFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import {
  countAffectedListings,
  readAffectedListingIds,
  readChannelListingProviderProductReferences,
  readChannelMappingReviewQueue,
  listChannelPublicationConnections,
  readChannelPublicationConnection,
  resolveChannelPublishableQuantity,
} from "../read-model/queries";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";
import { createChannelListingPublicationApplication } from "./listing-publication-application";

export type ChannelListingCompositionRuntimeDeps = Readonly<{
  eventStore: EventStore;
  transactionalEventStore?: Pick<PostgresEventStore, "appendToStreamInTransaction">;
  db: PgQueryable;
  profiles: ChannelCompositionProfileRegistry;
  listingIdDigest?: ChannelListingIdDigest;
}>;

export interface ChannelListingCompositionServices {
  replaceChannelConnectionPublicationSettings(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      settings: ChannelPublicationSettings;
      expectedStreamVersion: number;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult>;
  recordChannelMappingCandidates(
    input: Readonly<{
      connectionId: string;
      provenance: "compose-discovered" | "export-discovered";
      candidates: readonly ChannelMappingCandidate[];
    }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult>;
  decideChannelMappingReview(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      dimension: ChannelMappingDimension;
      sourceKey: string;
      decision: "accept" | "auto-accept" | "reject" | "revoke";
      targetKey: string | null;
      expectedStreamVersion: number;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult>;
  recordChannelListingDesiredState(
    input: Readonly<{ connectionId: string; listingId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ channelListingId: string }>>>;
  recordChannelListingPublicationOutcome(
    input: Readonly<{
      connectionId: string;
      channelListingId: string;
      operationId: string;
      reportedDesiredStateSequence: number;
      reportedListingRevision: number;
      reportedDesiredStateHash: string;
      outcome: ChannelPublicationOutcome;
      expectedStreamVersion: number;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult>;
  recordChannelListingPublicationOutcomeInTransaction(
    input: Readonly<{
      connectionId: string;
      channelListingId: string;
      operationId: string;
      reportedDesiredStateSequence: number;
      reportedListingRevision: number;
      reportedDesiredStateHash: string;
      outcome: ChannelPublicationOutcome;
      expectedStreamVersion: number;
    }>,
    context: EventStoreContext,
    db: PgQueryable,
  ): Promise<ChannelCommandResult>;
  enqueueChannelListingDesiredStateBackfill(
    input: Readonly<{ connectionId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ runId: string }>>>;
  enqueueChannelListingDesiredStateReconciliation(
    input: Readonly<{ connectionId: string; scope: ChannelListingReconciliationScope; scopeKey: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ runId: string }>>>;
  drainChannelListingDesiredStateReconciliation(
    input: Readonly<{ runId: string; limit: number }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult>;
  resolveChannelPublishableQuantity(
    input: Readonly<{ listingId: string }>,
  ): ReturnType<typeof resolveChannelPublishableQuantity>;
  readChannelListingProviderProductReferences(
    input: Readonly<{ connectionId: string; channelListingIds: readonly string[] }>,
  ): Promise<readonly ChannelReferenceRead[]>;
  readChannelMappingReviewQueue(
    input: Readonly<{ connectionId: string; cursor?: string | null; limit?: number }>,
  ): Promise<ChannelMappingReviewPage>;
  listChannelPublicationConnections(
    input: Readonly<{ accountId: string }>,
  ): Promise<readonly ChannelPublicationConnectionSummary[]>;
  readChannelPublicationConnection(
    input: Readonly<{ accountId: string; connectionId: string; cursor?: string | null; limit?: number }>,
  ): Promise<ChannelPublicationConnectionDetail | null>;
  readonly projectors: readonly ProjectionHandlerSet[];
}

export function createChannelListingCompositionRuntime(
  deps: ChannelListingCompositionRuntimeDeps,
): ChannelListingCompositionServices {
  const configurationRepository = createAggregateCommandHandler<
    ChannelPublicationConfigurationState,
    never,
    ChannelPublicationConfigurationEvent
  >({
    eventStore: deps.eventStore,
    codec: channelPublicationConfigurationEventCodec,
    initialState: () => initialChannelPublicationConfigurationState,
    evolve: evolveChannelPublicationConfiguration,
    decide: () => [],
    commitSourceContextName: "channels",
  }).repository;
  const linkRepository = createAggregateCommandHandler<
    ChannelListingAggregateState,
    never,
    Parameters<typeof evolveChannelListing>[1]
  >({
    eventStore: deps.eventStore,
    codec: channelListingEventCodec,
    initialState: () => initialChannelListingAggregateState,
    evolve: evolveChannelListing,
    decide: () => [],
    commitSourceContextName: "channels",
  }).repository;
  const runRepository = createAggregateCommandHandler<
    ChannelListingReconciliationState,
    never,
    ChannelListingReconciliationEvent
  >({
    eventStore: deps.eventStore,
    codec: channelListingReconciliationEventCodec,
    initialState: () => initialChannelListingReconciliationState,
    evolve: evolveChannelListingReconciliation,
    decide: () => [],
    commitSourceContextName: "channels",
  }).repository;
  const listingPublication = createChannelListingPublicationApplication({
    db: deps.db,
    profiles: deps.profiles,
    listingIdDigest: deps.listingIdDigest,
    linkRepository,
  });

  async function enqueue(
    input: Readonly<{ connectionId: string; scope: ChannelListingReconciliationScope; scopeKey: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ runId: string }>>> {
    assertClosed(input, ["connectionId", "scope", "scopeKey"]);
    assertText(input.connectionId, 128);
    assertText(input.scopeKey, 128);
    if (!["connection", "account", "catalog-item", "inventory-item"].includes(input.scope))
      throw new Error("Invalid reconciliation scope.");
    const streamId = reconciliationScopeStreamId(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await runRepository.load(streamId);
      const live = loaded.state.state === "pending" || loaded.state.state === "draining";
      const runId = live && loaded.state.runId ? loaded.state.runId : reconciliationRunId(streamId, loaded.version + 1);
      const event: ChannelListingReconciliationEvent = {
        type: "channels.channel-listing-reconciliation.run-enqueued",
        data: { runId, connectionId: input.connectionId, scope: input.scope, scopeKey: input.scopeKey },
      };
      try {
        const stored = await runRepository.append({
          streamId,
          expectedVersion: loaded.version === 0 ? "no_stream" : loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [event],
        });
        return { kind: "applied", value: { runId }, streamVersion: stored[0]!.streamVersion };
      } catch (error) {
        if (!isConcurrencyConflict(error)) throw error;
      }
    }
    return { kind: "refused", code: "stream-version-conflict" };
  }

  async function applyConfigurationDecision(
    connectionId: string,
    expectedVersion: number,
    decision: ConfigurationDecision,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult> {
    if (decision.kind === "refused") return decision;
    if (decision.kind === "unchanged") return { kind: "unchanged", value: undefined, streamVersion: expectedVersion };
    try {
      const stored = await configurationRepository.append({
        streamId: configurationStreamId(connectionId),
        expectedVersion: expectedVersion === 0 ? "no_stream" : expectedVersion,
        context,
        wakeSourceContextName: "channels",
        events: [decision.event],
      });
      return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
    } catch (error) {
      if (isConcurrencyConflict(error)) return { kind: "refused", code: "stream-version-conflict" };
      throw error;
    }
  }

  const services: ChannelListingCompositionServices = {
    replaceChannelConnectionPublicationSettings: async (input, context) => {
      assertClosed(input, ["accountId", "connectionId", "settings", "expectedStreamVersion"]);
      assertText(input.accountId, 128);
      assertText(input.connectionId, 128);
      assertChannelPublicationSettingsPayload(input.settings);
      assertVersion(input.expectedStreamVersion);
      if (!(await ownsConnection(deps.db, input.accountId, input.connectionId))) {
        return { kind: "refused", code: "unknown-link" };
      }
      const loaded = await configurationRepository.load(configurationStreamId(input.connectionId));
      if (loaded.version !== input.expectedStreamVersion) return { kind: "refused", code: "stream-version-conflict" };
      return applyConfigurationDecision(
        input.connectionId,
        loaded.version,
        decideReplaceChannelPublicationSettings(loaded.state, input.connectionId, input.settings),
        context,
      );
    },
    recordChannelMappingCandidates: async (input, context) => {
      assertClosed(input, ["connectionId", "provenance", "candidates"]);
      assertText(input.connectionId, 128);
      if (input.provenance !== "compose-discovered" && input.provenance !== "export-discovered") {
        throw new Error("Candidate provenance is invalid.");
      }
      assertChannelMappingCandidatesPayload(input.candidates);
      const loaded = await configurationRepository.load(configurationStreamId(input.connectionId));
      return applyConfigurationDecision(
        input.connectionId,
        loaded.version,
        decideRecordChannelMappingCandidates(loaded.state, input.connectionId, input.provenance, input.candidates),
        context,
      );
    },
    decideChannelMappingReview: async (input, context) => {
      assertClosed(input, [
        "accountId",
        "connectionId",
        "dimension",
        "sourceKey",
        "decision",
        "targetKey",
        "expectedStreamVersion",
      ]);
      assertText(input.accountId, 128);
      assertText(input.connectionId, 128);
      assertVersion(input.expectedStreamVersion);
      assertChannelMappingDecisionCommandPayload({
        dimension: input.dimension,
        sourceKey: input.sourceKey,
        decision: input.decision,
        targetKey: input.targetKey,
      });
      if (!(await ownsConnection(deps.db, input.accountId, input.connectionId))) {
        return { kind: "refused", code: "unknown-link" };
      }
      const loaded = await configurationRepository.load(configurationStreamId(input.connectionId));
      if (loaded.version !== input.expectedStreamVersion) return { kind: "refused", code: "stream-version-conflict" };
      return applyConfigurationDecision(
        input.connectionId,
        loaded.version,
        decideChannelMappingReview(loaded.state, {
          connectionId: input.connectionId,
          dimension: input.dimension,
          sourceKey: input.sourceKey,
          decision: input.decision,
          targetKey: input.targetKey,
        }),
        context,
      );
    },
    recordChannelListingDesiredState: async (input, context) => {
      assertClosed(input, ["connectionId", "listingId"]);
      assertText(input.connectionId, 128);
      assertText(input.listingId, 128);
      return listingPublication.recordDesiredState(input, context);
    },
    recordChannelListingPublicationOutcome: async (input, context) => {
      assertClosed(input, [
        "connectionId",
        "channelListingId",
        "operationId",
        "reportedDesiredStateSequence",
        "reportedListingRevision",
        "reportedDesiredStateHash",
        "outcome",
        "expectedStreamVersion",
      ]);
      assertText(input.connectionId, 128);
      assertText(input.channelListingId, 128);
      assertText(input.operationId, 512);
      assertVersion(input.reportedDesiredStateSequence);
      assertVersion(input.reportedListingRevision);
      if (!/^[a-f0-9]{64}$/.test(input.reportedDesiredStateHash)) {
        throw new Error("Desired-state hash is invalid.");
      }
      assertChannelPublicationOutcomePayload(input.outcome);
      assertVersion(input.expectedStreamVersion);
      if (input.expectedStreamVersion !== input.reportedDesiredStateSequence) {
        return { kind: "refused", code: "desired-state-mismatch" };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await linkRepository.load(linkStreamId(input.channelListingId));
        const decision = decideChannelListingPublicationOutcome(loaded.state, input);
        if (decision.kind === "refused") return decision;
        if (!(await reservePublicationOperation(deps.db, input))) {
          return { kind: "refused", code: "operation-rebound" };
        }
        if (decision.kind === "unchanged") {
          return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
        }
        try {
          const stored = await linkRepository.append({
            streamId: linkStreamId(input.channelListingId),
            expectedVersion: loaded.version,
            context,
            wakeSourceContextName: "channels",
            events: [decision.event],
          });
          if (decision.recompose) {
            await listingPublication.recordDesiredState(
              { connectionId: input.connectionId, listingId: loaded.state.listingId },
              context,
            );
          }
          return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
        } catch (error) {
          if (!isConcurrencyConflict(error)) throw error;
        }
      }
      return { kind: "refused", code: "stream-version-conflict" };
    },
    recordChannelListingPublicationOutcomeInTransaction: async (input, context, db) => {
      assertClosed(input, [
        "connectionId",
        "channelListingId",
        "operationId",
        "reportedDesiredStateSequence",
        "reportedListingRevision",
        "reportedDesiredStateHash",
        "outcome",
        "expectedStreamVersion",
      ]);
      assertText(input.connectionId, 128);
      assertText(input.channelListingId, 128);
      assertText(input.operationId, 512);
      assertVersion(input.reportedDesiredStateSequence);
      assertVersion(input.reportedListingRevision);
      if (!/^[a-f0-9]{64}$/.test(input.reportedDesiredStateHash)) {
        throw new Error("Desired-state hash is invalid.");
      }
      assertChannelPublicationOutcomePayload(input.outcome);
      assertVersion(input.expectedStreamVersion);
      if (input.expectedStreamVersion !== input.reportedDesiredStateSequence) {
        return { kind: "refused", code: "desired-state-mismatch" };
      }
      const transactionalEventStore = deps.transactionalEventStore;
      if (!transactionalEventStore) throw new Error("The transaction-bound event store is not installed.");
      const loaded = await linkRepository.load(linkStreamId(input.channelListingId));
      const decision = decideChannelListingPublicationOutcome(loaded.state, input);
      if (decision.kind === "refused") return decision;
      if (!(await reservePublicationOperation(db, input))) {
        return { kind: "refused", code: "operation-rebound" };
      }
      if (decision.kind === "unchanged") {
        return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
      }
      const stored = await transactionalEventStore.appendToStreamInTransaction(db, {
        streamId: linkStreamId(input.channelListingId),
        expectedVersion: loaded.version,
        context,
        wakeSourceContextName: "channels",
        events: [channelListingEventCodec.encode(decision.event)],
      });
      return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
    },
    enqueueChannelListingDesiredStateBackfill: (input, context) =>
      enqueue({ connectionId: input.connectionId, scope: "connection", scopeKey: input.connectionId }, context),
    enqueueChannelListingDesiredStateReconciliation: enqueue,
    drainChannelListingDesiredStateReconciliation: async (input, context) => {
      assertClosed(input, ["runId", "limit"]);
      assertText(input.runId, 128);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
        throw new Error("Drain limit is invalid.");
      const loaded = await runRepository.load(runStreamId(input.runId));
      const state = loaded.state;
      if (state.runId === null || state.runId !== input.runId) {
        return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
      }
      if (state.state === "complete" || state.state === "failed") {
        return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
      }
      if (state.restartRequired) {
        const event: ChannelListingReconciliationEvent = {
          type: "channels.channel-listing-reconciliation.chunk-drained",
          data: { runId: input.runId, fromCursor: state.cursor, toCursor: null, processedCount: 0, remaining: true },
        };
        const stored = await runRepository.append({
          streamId: runStreamId(input.runId),
          expectedVersion: loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [event],
        });
        return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
      }
      const scopeInput = { connectionId: state.connectionId!, scope: state.scope!, scopeKey: state.scopeKey! };
      const listingIds = await readAffectedListingIds(deps.db, {
        ...scopeInput,
        afterListingId: state.cursor,
        limit: input.limit + 1,
      });
      const page = listingIds.slice(0, input.limit);
      for (const listingId of page)
        await services.recordChannelListingDesiredState({ connectionId: state.connectionId!, listingId }, context);
      const remaining = listingIds.length > input.limit;
      if (!remaining) {
        const total = await countAffectedListings(deps.db, scopeInput);
        const processedCount = state.processedCount + page.length;
        const outcome =
          processedCount === total
            ? { kind: "complete" as const, processedCount }
            : { kind: "failed" as const, code: "affected-count-mismatch" };
        const event: ChannelListingReconciliationEvent = {
          type: "channels.channel-listing-reconciliation.run-settled",
          data: { runId: input.runId, outcome },
        };
        const stored = await runRepository.append({
          streamId: runStreamId(input.runId),
          expectedVersion: loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [event],
        });
        return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
      }
      const event: ChannelListingReconciliationEvent = {
        type: "channels.channel-listing-reconciliation.chunk-drained",
        data: {
          runId: input.runId,
          fromCursor: state.cursor,
          toCursor: page.at(-1) ?? state.cursor,
          processedCount: page.length,
          remaining: true,
        },
      };
      const stored = await runRepository.append({
        streamId: runStreamId(input.runId),
        expectedVersion: loaded.version,
        context,
        wakeSourceContextName: "channels",
        events: [event],
      });
      return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
    },
    resolveChannelPublishableQuantity: (input) => resolveChannelPublishableQuantity(deps.db, input),
    readChannelListingProviderProductReferences: (input) => readChannelListingProviderProductReferences(deps.db, input),
    readChannelMappingReviewQueue: (input) => readChannelMappingReviewQueue(deps.db, input),
    listChannelPublicationConnections: (input) => listChannelPublicationConnections(deps.db, input),
    readChannelPublicationConnection: (input) => readChannelPublicationConnection(deps.db, input),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "channel-marketplace-publication-facts",
        handlers: buildChannelMarketplaceFactsProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "channel-catalog-publication-facts",
        handlers: buildChannelCatalogFactsProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "channel-inventory-publication-facts",
        handlers: buildChannelInventoryFactsProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "channel-connection-publication-facts",
        handlers: buildChannelConnectionFactsProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "channel-listing-state-projection",
        handlers: buildChannelListingStateProjectionHandlers(deps.db),
      }),
    ],
  };
  return services;
}

function configurationStreamId(connectionId: string): string {
  return `channels.channel-publication-configuration-${connectionId}`;
}
function linkStreamId(channelListingId: string): string {
  return `channels.channel-listing-${channelListingId}`;
}
function runStreamId(runId: string): string {
  const match = /^clr_([a-f0-9]{64})_\d+$/.exec(runId);
  if (!match) throw new Error("Reconciliation run ID is invalid.");
  return `channels.channel-listing-reconciliation-scope-${match[1]}`;
}
function reconciliationScopeStreamId(
  input: Readonly<{
    connectionId: string;
    scope: ChannelListingReconciliationScope;
    scopeKey: string;
  }>,
): string {
  const framed = JSON.stringify([input.connectionId, input.scope, input.scopeKey]);
  const digest = createHash("sha256").update(framed, "utf8").digest("hex");
  return `channels.channel-listing-reconciliation-scope-${digest}`;
}
function reconciliationRunId(streamId: string, generationVersion: number): string {
  return `clr_${streamId.slice(-64)}_${generationVersion}`;
}
function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return !!error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict";
}
function assertClosed(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)))
    throw new Error("Input is not closed.");
}
function assertText(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > max)
    throw new Error("Text input is invalid.");
}
function assertVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Version is invalid.");
}

async function ownsConnection(db: PgQueryable, accountId: string, connectionId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM channels_connection_facts WHERE account_id=$1 AND connection_id=$2 LIMIT 1`,
    [accountId, connectionId],
  );
  return result.rows.length === 1;
}

async function reservePublicationOperation(
  db: PgQueryable,
  input: Readonly<{
    channelListingId: string;
    operationId: string;
    reportedDesiredStateSequence: number;
    reportedListingRevision: number;
    reportedDesiredStateHash: string;
  }>,
): Promise<boolean> {
  await db.query(
    `INSERT INTO channels_channel_publication_operations
       (operation_id,channel_listing_id,desired_state_sequence,listing_revision,desired_state_hash,bound_at)
     VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (operation_id) DO NOTHING`,
    [
      input.operationId,
      input.channelListingId,
      input.reportedDesiredStateSequence,
      input.reportedListingRevision,
      input.reportedDesiredStateHash,
    ],
  );
  const binding = await db.query<{
    channel_listing_id: string;
    desired_state_sequence: string | number;
    listing_revision: string | number;
    desired_state_hash: string;
  }>(
    `SELECT channel_listing_id,desired_state_sequence,listing_revision,desired_state_hash
     FROM channels_channel_publication_operations WHERE operation_id=$1`,
    [input.operationId],
  );
  const row = binding.rows[0];
  return (
    row?.channel_listing_id === input.channelListingId &&
    Number(row.desired_state_sequence) === input.reportedDesiredStateSequence &&
    Number(row.listing_revision) === input.reportedListingRevision &&
    row.desired_state_hash === input.reportedDesiredStateHash
  );
}
