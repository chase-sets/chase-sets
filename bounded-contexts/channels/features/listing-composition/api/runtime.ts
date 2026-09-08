import { randomUUID } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { deriveChannelListingId, type ChannelListingIdDigest } from "../domain/canonical";
import {
  channelListingEventCodec,
  channelListingReconciliationEventCodec,
  channelPublicationConfigurationEventCodec,
} from "../domain/codecs";
import { composeChannelListingPublication } from "../domain/compose";
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
  ChannelListingLinkState,
  ChannelPublicationConnectionDetail,
  ChannelPublicationConnectionSummary,
  ChannelPublicationOutcome,
  ChannelPublicationSettings,
  ChannelReferenceRead,
} from "../domain/contracts";
import {
  decideChannelListingComposition,
  decideChannelListingPublicationOutcome,
  evolveChannelListing,
  initialChannelListingAggregateState,
  type ChannelListingAggregateState,
} from "../domain/link";
import { parseChannelListingCompositionInput } from "../domain/parse";
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
  readChannelListingCompositionFacts,
  readChannelListingProviderProductReferences,
  readChannelMappingReviewQueue,
  listChannelPublicationConnections,
  readChannelPublicationConnection,
  resolveChannelPublishableQuantity,
} from "../read-model/queries";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";

export type ChannelListingCompositionRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  profiles: ChannelCompositionProfileRegistry;
  listingIdDigest?: ChannelListingIdDigest;
}>;

export interface ChannelListingCompositionServices {
  replaceChannelConnectionPublicationSettings(
    input: Readonly<{ connectionId: string; settings: ChannelPublicationSettings; expectedStreamVersion: number }>,
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

  async function enqueue(
    input: Readonly<{ connectionId: string; scope: ChannelListingReconciliationScope; scopeKey: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ runId: string }>>> {
    assertClosed(input, ["connectionId", "scope", "scopeKey"]);
    assertText(input.connectionId, 128);
    assertText(input.scopeKey, 128);
    if (!["connection", "account", "catalog-item", "inventory-item"].includes(input.scope))
      throw new Error("Invalid reconciliation scope.");
    const live = await deps.db.query<{ run_id: string }>(
      `SELECT run_id FROM channels_listing_reconciliation_runs
       WHERE connection_id=$1 AND scope=$2 AND scope_key=$3 AND state IN ('pending','draining') LIMIT 1`,
      [input.connectionId, input.scope, input.scopeKey],
    );
    const runId = live.rows[0]?.run_id ?? `clr_${randomUUID()}`;
    const loaded = await runRepository.load(runStreamId(runId));
    if (loaded.state.state === "complete" || loaded.state.state === "failed") {
      return { kind: "unchanged", value: { runId }, streamVersion: loaded.version };
    }
    const event: ChannelListingReconciliationEvent = {
      type: "channels.channel-listing-reconciliation.run-enqueued",
      data: { runId, connectionId: input.connectionId, scope: input.scope, scopeKey: input.scopeKey },
    };
    const stored = await runRepository.append({
      streamId: runStreamId(runId),
      expectedVersion: loaded.version === 0 ? "no_stream" : loaded.version,
      context,
      wakeSourceContextName: "channels",
      events: [event],
    });
    return { kind: "applied", value: { runId }, streamVersion: stored[0]!.streamVersion };
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
      assertClosed(input, ["connectionId", "settings", "expectedStreamVersion"]);
      validateSettings(input.settings);
      assertVersion(input.expectedStreamVersion);
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
      validateCandidates(input.candidates);
      const loaded = await configurationRepository.load(configurationStreamId(input.connectionId));
      return applyConfigurationDecision(
        input.connectionId,
        loaded.version,
        decideRecordChannelMappingCandidates(loaded.state, input.connectionId, input.provenance, input.candidates),
        context,
      );
    },
    decideChannelMappingReview: async (input, context) => {
      assertClosed(input, ["connectionId", "dimension", "sourceKey", "decision", "targetKey", "expectedStreamVersion"]);
      assertVersion(input.expectedStreamVersion);
      assertText(input.sourceKey, 512);
      const loaded = await configurationRepository.load(configurationStreamId(input.connectionId));
      if (loaded.version !== input.expectedStreamVersion) return { kind: "refused", code: "stream-version-conflict" };
      return applyConfigurationDecision(
        input.connectionId,
        loaded.version,
        decideChannelMappingReview(loaded.state, input),
        context,
      );
    },
    recordChannelListingDesiredState: async (input, context) => {
      assertClosed(input, ["connectionId", "listingId"]);
      assertText(input.connectionId, 128);
      assertText(input.listingId, 128);
      const channelListingId = deriveChannelListingId(input.connectionId, input.listingId, deps.listingIdDigest);
      const collision = await deps.db.query<{ connection_id: string; listing_id: string }>(
        `SELECT connection_id,listing_id FROM channels_channel_listing_links WHERE channel_listing_id=$1`,
        [channelListingId],
      );
      if (
        collision.rows[0] &&
        (collision.rows[0].connection_id !== input.connectionId || collision.rows[0].listing_id !== input.listingId)
      ) {
        return { kind: "refused", code: "channel-listing-id-collision" };
      }
      const facts = await readChannelListingCompositionFacts(deps.db, input);
      if (!facts) return { kind: "refused", code: "unknown-link" };
      const loaded = await linkRepository.load(linkStreamId(channelListingId));
      const profile = deps.profiles.get({
        providerKey: facts.connection.providerKey,
        environment: facts.connection.environment,
      });
      const candidate = {
        ...facts,
        profile: profile ? { kind: "registered" as const, profile } : { kind: "unregistered" as const },
        link: loaded.state.exists
          ? { kind: "existing" as const, state: publicLinkState(loaded.state) }
          : { kind: "none" as const },
      };
      const parsed = parseChannelListingCompositionInput(candidate);
      if (parsed.kind === "invalid")
        throw new Error(`Channel Listing Composition input rejected: ${parsed.programmingError}`);
      const result = composeChannelListingPublication(parsed.input, deps.listingIdDigest);
      const listingRevision = parsed.input.listing.kind === "present" ? parsed.input.listing.listingRevision : 0;
      const decision = decideChannelListingComposition(loaded.state, {
        connectionId: input.connectionId,
        channelListingId,
        listingId: input.listingId,
        listingRevision,
        nextStreamVersion: loaded.version + 1,
        result,
      });
      if (decision.kind === "unchanged") {
        return { kind: "unchanged", value: { channelListingId }, streamVersion: loaded.version };
      }
      try {
        const stored = await linkRepository.append({
          streamId: linkStreamId(channelListingId),
          expectedVersion: loaded.version === 0 ? "no_stream" : loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [decision.event],
        });
        return { kind: "applied", value: { channelListingId }, streamVersion: stored[0]!.streamVersion };
      } catch (error) {
        if (isConcurrencyConflict(error)) return { kind: "refused", code: "stream-version-conflict" };
        throw error;
      }
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
      const loaded = await linkRepository.load(linkStreamId(input.channelListingId));
      if (loaded.version !== input.expectedStreamVersion) return { kind: "refused", code: "stream-version-conflict" };
      const decision = decideChannelListingPublicationOutcome(loaded.state, input);
      if (decision.kind === "refused") return decision;
      if (decision.kind === "unchanged") return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
      try {
        const stored = await linkRepository.append({
          streamId: linkStreamId(input.channelListingId),
          expectedVersion: loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [decision.event],
        });
        if (decision.recompose) {
          await services.recordChannelListingDesiredState(
            { connectionId: input.connectionId, listingId: loaded.state.listingId },
            context,
          );
        }
        return { kind: "applied", value: undefined, streamVersion: stored[0]!.streamVersion };
      } catch (error) {
        if (isConcurrencyConflict(error)) return { kind: "refused", code: "stream-version-conflict" };
        throw error;
      }
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
      if (state.runId === null) return { kind: "unchanged", value: undefined, streamVersion: loaded.version };
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
function publicLinkState(state: ChannelListingAggregateState): ChannelListingLinkState {
  return {
    connectionId: state.connectionId,
    channelListingId: state.channelListingId,
    listingId: state.listingId,
    externalListingId: state.externalListingId,
    externalOfferId: state.externalOfferId,
    providerRevision: state.providerRevision,
    lastDesiredStateSequence: state.lastDesiredStateSequence,
    lastDesiredListingRevision: state.lastDesiredListingRevision,
    lastDesiredStateHash: state.lastDesiredStateHash,
    lastDesiredIntent: state.lastDesiredIntent,
    lastPushedListingRevision: state.lastPushedListingRevision,
    lastPushedPriceAmountMinor: state.lastPushedPriceAmountMinor,
    lastPushedPriceCurrency: state.lastPushedPriceCurrency,
    lastPushedQuantity: state.lastPushedQuantity,
    publishState: state.publishState,
    blockingReasonCodes: state.blockingReasonCodes,
    failureReason: state.failureReason,
    driftStatus: state.driftStatus,
    lastStreamVersion: state.lastStreamVersion,
  };
}
function linkStreamId(channelListingId: string): string {
  return `channels.channel-listing-${channelListingId}`;
}
function runStreamId(runId: string): string {
  return `channels.channel-listing-reconciliation-${runId}`;
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
function validateSettings(settings: ChannelPublicationSettings): void {
  assertClosed(settings, [
    "titlePrefix",
    "titleSuffix",
    "descriptionFooter",
    "categoryAllowlist",
    "excludedListingIds",
  ]);
  if (!Array.isArray(settings.categoryAllowlist) || !Array.isArray(settings.excludedListingIds))
    throw new Error("Settings arrays are invalid.");
}
function validateCandidates(candidates: readonly ChannelMappingCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length > 500) throw new Error("Candidates are invalid.");
  const seen = new Set<string>();
  for (const candidate of candidates) {
    assertClosed(candidate, ["dimension", "sourceKey", "proposedTargetKey", "confidenceTier", "evidence"]);
    assertText(candidate.sourceKey, 512);
    const key = `${candidate.dimension}\u0000${candidate.sourceKey}`;
    if (seen.has(key)) throw new Error("Candidate keys must be unique.");
    seen.add(key);
  }
}
