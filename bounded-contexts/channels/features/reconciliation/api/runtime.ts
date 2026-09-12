import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { classifyChannelDrift } from "../domain/classification";
import type {
  AcceptChannelDrift,
  AcceptedChannelDrift,
  ChannelDriftDecision,
  ChannelDriftObservationV1,
  ChannelHealthObservationV1,
  ChannelOutboundHold,
  ChannelReconciliationCounts,
  ChannelReconciliationRunResult,
  ChannelReconciliationRuntimeDependencies,
  ChannelReconciliationServices,
  RepushChannelListing,
} from "../domain/contracts";
import { mapChannelDriftToHealthObservation, mapPersistentGapToHealthObservation } from "../domain/health";
import type { ChannelOutboundKillSwitchPolicyValue } from "../domain/policy";
import {
  readChannelDriftAttentionContribution,
  readChannelDriftDecision,
  readChannelReconciliationMetrics,
  readPendingHealthObservations,
} from "../read-model/queries";
import {
  listDueReconciliationConnectionIds,
  readExpectedReconciliationListings,
  readReconciliationConnection,
  type ReconciliationConnectionSource,
  type ReconciliationExpectedListing,
} from "../read-model/source";
import { resolveChannelExternalSaleTarget } from "../read-model/sale-target";
import type {
  ChannelSaleFetchResult,
  ChannelSaleLineV1,
  ChannelStateFetchResult,
  ChannelStateLineV1,
} from "../../publication-port/domain/contracts";

const zeroCounts = (): MutableCounts => ({
  listingsReconciled: 0,
  inSync: 0,
  repairable: 0,
  foreignEdit: 0,
  structural: 0,
  sourceUnavailable: 0,
  repairsEnqueued: 0,
  repairsSucceeded: 0,
  missedSaleGaps: 0,
});

type MutableCounts = { -readonly [K in keyof ChannelReconciliationCounts]: ChannelReconciliationCounts[K] };

export function createChannelReconciliationRuntime(
  dependencies: ChannelReconciliationRuntimeDependencies,
): ChannelReconciliationServices {
  const now = () => (dependencies.clock?.now() ?? new Date()).toISOString();

  async function reconcileConnection(
    input: Parameters<ChannelReconciliationServices["reconcileConnection"]>[0],
    context: EventStoreContext,
  ): Promise<ChannelReconciliationRunResult> {
    assertPositive(input.sourceAttempt, "sourceAttempt");
    if (input.healthAuthority) {
      assertPositive(input.healthAuthority.policyRevision, "healthAuthority.policyRevision");
      assertPositive(input.healthAuthority.evaluationGeneration, "healthAuthority.evaluationGeneration");
    }
    const connection = await readReconciliationConnection(dependencies.db, input.connectionId);
    if (!connection) throw new Error("Channel Reconciliation connection was not found.");
    assertAccountContext(connection, context);
    if (connection.status === "pending-setup" || connection.status === "disconnected") {
      throw new Error("Channel Reconciliation connection is not eligible for reconciliation.");
    }
    const resolvedPolicy = await dependencies.resolvePolicy();
    const policy = resolvedPolicy.value;
    const killSwitch = await safeKillSwitch(dependencies.resolveKillSwitch);
    const hold = await readChannelOutboundHold({
      connection,
      killSwitch,
      healthHeld: (await dependencies.readHealthHold?.(connection.connectionId)) ?? false,
    });
    const startedAt = now();
    const claim = await claimRun(dependencies, connection, resolvedPolicy.revision, startedAt, context);
    const counts = zeroCounts();
    if (hold.held) {
      return finishRun(dependencies, connection, claim, "held", counts, false, policy.cadenceMs, startedAt, context);
    }

    const expected = await readExpectedReconciliationListings(dependencies.db, {
      connectionId: connection.connectionId,
      limit: policy.maxListingsPerRun,
    });
    const provider = input.registry.get({ providerKey: connection.providerKey, environment: connection.environment });
    const publication = provider?.publication ?? null;
    let stateResult: ChannelStateFetchResult = { kind: "bounded-unknown", reason: "source-error" };
    if (expected.bounded) {
      stateResult = { kind: "bounded-unknown", reason: "hard-cap" };
    } else if (publication?.execution === "inline") {
      try {
        stateResult = await publication.fetchChannelState({ connectionId: connection.connectionId });
      } catch {
        stateResult = { kind: "bounded-unknown", reason: "source-error" };
      }
    }
    const absentByDesign = publication?.execution !== "inline";
    const sourceAuthority: ChannelDriftObservationV1["sourceAuthority"] = absentByDesign
      ? {
          kind: "absent-by-design",
          reason:
            publication?.execution === "claimed"
              ? "claimed-snapshot-not-installed"
              : "reconciliation-capability-unregistered",
        }
      : stateResult.kind === "complete"
        ? { kind: "complete", collectedCount: stateResult.collectedCount, authorityTotal: stateResult.authorityTotal }
        : { kind: "declared-incomplete", reason: stateResult.reason };
    const observedByIdentity =
      stateResult.kind === "complete" ? indexObservedState(stateResult.items) : new Map<string, ChannelStateLineV1>();
    let resultOrdinal = 0;
    const priorAttention = await readPriorAttentionState(dependencies.db, connection.connectionId);

    await closeTransientFindings(
      dependencies.db,
      connection.connectionId,
      claim.generation,
      stateResult.kind === "complete",
      startedAt,
    );
    for (const listing of expected.items) {
      const decision = await readChannelDriftDecision(dependencies.db, listing);
      const observed = resolveObserved(listing, observedByIdentity);
      if (listing.externalListingId) {
        observedByIdentity.delete(externalIdentity(listing.externalListingId, listing.externalOfferId));
      }
      const observation: ChannelDriftObservationV1 = {
        connectionId: listing.connectionId,
        channelListingId: listing.channelListingId,
        expectedRevision: listing.expectedRevision,
        expectedPrice: listing.expectedPrice,
        expectedQuantity: listing.expectedQuantity,
        expectedMaterialFingerprint: listing.expectedMaterialFingerprint,
        lastAppliedRevision: listing.lastAppliedRevision,
        acceptedForeignEdit: decision.accepted,
        observed,
        sourceAuthority,
      };
      const classification = classifyChannelDrift(observation);
      counts.listingsReconciled += 1;
      incrementClassification(counts, classification);
      await writeReconciliationItem(dependencies.db, listing, claim.generation, classification, observed, startedAt);

      if (classification === "repairable") {
        await dependencies.outboundSync.enqueueDesiredState(listing.desired);
        counts.repairsEnqueued += 1;
      } else if (classification === "foreign-edit" && decision.repushRequested && decision.operationId) {
        await dependencies.outboundSync.enqueueRepush({
          ...listing.desired,
          repushOperationId: decision.operationId,
        });
        counts.repairsEnqueued += 1;
        await markRepushConsumed(dependencies, decision, context, startedAt);
      }

      resultOrdinal += 1;
      const health = input.healthAuthority
        ? mapChannelDriftToHealthObservation({
            connectionId: connection.connectionId,
            runGeneration: claim.generation,
            sourceAttempt: input.sourceAttempt,
            resultOrdinal,
            policyRevision: input.healthAuthority.policyRevision,
            evaluationGeneration: input.healthAuthority.evaluationGeneration,
            classification,
            sourceAuthority,
            materialFingerprint: observed.present ? observed.fingerprint : listing.expectedMaterialFingerprint,
            occurredAt: startedAt,
          })
        : null;
      if (health) await writeHealthObservation(dependencies.db, health);
    }

    if (stateResult.kind === "complete") {
      for (const [identity, item] of observedByIdentity) {
        counts.listingsReconciled += 1;
        counts.structural += 1;
        await writeFinding(
          dependencies.db,
          connection.connectionId,
          `state-${digest(identity)}`,
          claim.generation,
          "unmapped-channel-state",
          null,
          item.fingerprint,
          "channel-state-link-not-found",
          startedAt,
        );
        if (input.healthAuthority) {
          resultOrdinal += 1;
          await writeHealthObservation(
            dependencies.db,
            mapChannelDriftToHealthObservation({
              connectionId: connection.connectionId,
              runGeneration: claim.generation,
              sourceAttempt: input.sourceAttempt,
              resultOrdinal,
              policyRevision: input.healthAuthority.policyRevision,
              evaluationGeneration: input.healthAuthority.evaluationGeneration,
              classification: "structural",
              sourceAuthority,
              materialFingerprint: item.fingerprint,
              occurredAt: startedAt,
            })!,
          );
        }
      }
    }

    let saleComplete = true;
    let saleAuthorityComplete = false;
    if (publication?.execution === "inline") {
      let saleResult: ChannelSaleFetchResult;
      try {
        saleResult = await publication.fetchSales({
          connectionId: connection.connectionId,
          since: new Date(Date.parse(startedAt) - policy.saleLookbackMs).toISOString(),
        });
      } catch {
        saleResult = { kind: "bounded-unknown", reason: "source-error" };
      }
      saleComplete = saleResult.kind === "complete" && saleResult.lines.length <= policy.maxSaleLinesPerRun;
      if (saleComplete && saleResult.kind === "complete") {
        saleAuthorityComplete = true;
        for (const line of saleResult.lines) {
          const result = await recordSaleLine(
            dependencies,
            connection,
            line,
            claim.generation,
            policy.backdatingAttentionAfterMs,
            startedAt,
          );
          if (result.gap) counts.missedSaleGaps += 1;
          if (result.structural) counts.structural += 1;
          if (result.structural && input.healthAuthority) {
            resultOrdinal += 1;
            await writeHealthObservation(
              dependencies.db,
              mapChannelDriftToHealthObservation({
                connectionId: connection.connectionId,
                runGeneration: claim.generation,
                sourceAttempt: input.sourceAttempt,
                resultOrdinal,
                policyRevision: input.healthAuthority.policyRevision,
                evaluationGeneration: input.healthAuthority.evaluationGeneration,
                classification: "structural",
                sourceAuthority: {
                  kind: "complete",
                  collectedCount: saleResult.collectedCount,
                  authorityTotal: saleResult.authorityTotal,
                },
                materialFingerprint: digest(JSON.stringify(line.saleKey)),
                occurredAt: startedAt,
              })!,
            );
          }
        }
      } else {
        counts.sourceUnavailable += 1;
        resultOrdinal += 1;
        if (input.healthAuthority)
          await writeHealthObservation(
            dependencies.db,
            mapChannelDriftToHealthObservation({
              connectionId: connection.connectionId,
              runGeneration: claim.generation,
              sourceAttempt: input.sourceAttempt,
              resultOrdinal,
              policyRevision: input.healthAuthority.policyRevision,
              evaluationGeneration: input.healthAuthority.evaluationGeneration,
              classification: "source-unavailable",
              sourceAuthority: { kind: "declared-incomplete", reason: safeSaleReason(saleResult) },
              materialFingerprint: "sale-source",
              occurredAt: startedAt,
            })!,
          );
      }
    }

    const persistentGaps = saleAuthorityComplete
      ? await readPersistentGapFingerprints(
          dependencies.db,
          connection.connectionId,
          claim.generation,
          policy.gapPersistenceRuns,
        )
      : [];
    for (const gapFingerprint of persistentGaps) {
      await ensurePersistentGapFinding(
        dependencies.db,
        connection.connectionId,
        gapFingerprint,
        claim.generation,
        startedAt,
      );
      if (!input.healthAuthority) continue;
      resultOrdinal += 1;
      await writeHealthObservation(
        dependencies.db,
        mapPersistentGapToHealthObservation({
          connectionId: connection.connectionId,
          runGeneration: claim.generation,
          sourceAttempt: input.sourceAttempt,
          resultOrdinal,
          policyRevision: input.healthAuthority.policyRevision,
          evaluationGeneration: input.healthAuthority.evaluationGeneration,
          gapFingerprint,
          occurredAt: startedAt,
        }),
      );
    }

    const openFindingCount = await countOpenFindings(dependencies.db, connection.connectionId);
    const clean =
      stateResult.kind === "complete" &&
      saleComplete &&
      counts.repairable === 0 &&
      counts.foreignEdit === 0 &&
      counts.structural === 0 &&
      counts.sourceUnavailable === 0 &&
      openFindingCount === 0;
    if (clean && priorAttention.count > 0) {
      await writeAttentionResolution(
        dependencies.db,
        connection.connectionId,
        claim.generation,
        priorAttention.fingerprint,
        priorAttention.allForeign &&
          (await allPriorForeignEditsAccepted(dependencies.db, priorAttention.channelListingIds))
          ? "handled-on-channel"
          : "recovered-automatically",
        startedAt,
      );
    }
    const state = stateResult.kind === "complete" && saleComplete ? "completed" : "bounded-unknown";
    return finishRun(dependencies, connection, claim, state, counts, clean, policy.cadenceMs, startedAt, context);
  }

  return {
    reconcileConnection,
    reconcileDueConnections: async (input, contextForAccount) => {
      const current = now();
      const ids = await listDueReconciliationConnectionIds(dependencies.db, {
        now: current,
        limit: input.limit ?? 100,
      });
      const results: ChannelReconciliationRunResult[] = [];
      for (const connectionId of ids) {
        const connection = await readReconciliationConnection(dependencies.db, connectionId);
        if (!connection) continue;
        results.push(
          await reconcileConnection(
            {
              connectionId,
              registry: input.registry,
              sourceAttempt: input.sourceAttempt,
              healthAuthority: input.healthAuthority,
            },
            contextForAccount(connection.accountId),
          ),
        );
      }
      return results;
    },
    acceptChannelDrift: (input, context) => decideDrift(dependencies, "accept", input, context, now()),
    repushChannelListing: (input, context) => decideDrift(dependencies, "repush", input, context, now()),
    readChannelDriftDecision: (input) => readChannelDriftDecision(dependencies.db, input),
    readChannelDriftAttentionContribution: (input) => readChannelDriftAttentionContribution(dependencies.db, input),
    readChannelReconciliationMetrics: (input) => readChannelReconciliationMetrics(dependencies.db, input),
    readPendingHealthObservations: (input) => readPendingHealthObservations(dependencies.db, input),
  };
}

export async function readChannelOutboundHold(
  input: Readonly<{
    connection: Pick<ReconciliationConnectionSource, "connectionId" | "providerKey" | "status">;
    killSwitch: ChannelOutboundKillSwitchPolicyValue | null;
    healthHeld: boolean;
  }>,
): Promise<ChannelOutboundHold> {
  const sources: ChannelOutboundHold["sources"][number][] = [];
  if (input.connection.status === "paused") sources.push("seller-pause");
  if (input.healthHeld) sources.push("health");
  if (
    input.killSwitch === null ||
    input.killSwitch.heldConnectionIds.includes(input.connection.connectionId) ||
    input.killSwitch.heldProviderKeys.includes(input.connection.providerKey)
  ) {
    sources.push("operator-kill");
  }
  return { held: sources.length > 0, sources };
}

async function claimRun(
  dependencies: ChannelReconciliationRuntimeDependencies,
  connection: ReconciliationConnectionSource,
  policyRevision: number,
  startedAt: string,
  context: EventStoreContext,
): Promise<Readonly<{ generation: number; revision: number; runFingerprint: string; streamVersion: number }>> {
  const history = await loadRunHistory(dependencies, connection.connectionId);
  if (history.state === "running") throw new Error("Channel Reconciliation run is already claimed.");
  const generation = history.generation + 1;
  const runFingerprint = digest(`${connection.connectionId}\0${generation}\0${policyRevision}`);
  return withPgTransaction(dependencies.db, async (db) => {
    const empty = JSON.stringify(zeroCounts());
    await db.query(
      `INSERT INTO channel_reconciliation_state
         (connection_id,account_id,provider_key,environment,state,generation,revision,run_fingerprint,
          cadence_policy_revision,next_due_at,last_clean_run_at,counts,updated_at)
       VALUES ($1,$2,$3,$4,'idle',0,1,NULL,$5,$6,NULL,$7::jsonb,$6)
       ON CONFLICT (connection_id) DO NOTHING`,
      [
        connection.connectionId,
        connection.accountId,
        connection.providerKey,
        connection.environment,
        policyRevision,
        startedAt,
        empty,
      ],
    );
    const current = await db.query<{ generation: string | number; revision: string | number; state: string }>(
      `SELECT generation,revision,state FROM channel_reconciliation_state WHERE connection_id=$1 FOR UPDATE`,
      [connection.connectionId],
    );
    const row = current.rows[0]!;
    if (Number(row.generation) !== history.generation || row.state !== history.state) {
      throw new Error("Channel Reconciliation run projection does not match its event history.");
    }
    const updated = await db.query<{ revision: string | number }>(
      `UPDATE channel_reconciliation_state SET state='running',generation=$2,revision=revision+1,
         run_fingerprint=$3,cadence_policy_revision=$4,updated_at=$5
       WHERE connection_id=$1 AND generation=$6 AND revision=$7 AND state=$8 RETURNING revision`,
      [
        connection.connectionId,
        generation,
        runFingerprint,
        policyRevision,
        startedAt,
        row.generation,
        row.revision,
        row.state,
      ],
    );
    if (!updated.rows[0]) throw new Error("Channel Reconciliation run claim lost its generation fence.");
    await dependencies.eventStore.appendToStreamInTransaction(db, {
      streamId: runStreamId(connection.connectionId),
      expectedVersion: history.version === 0 ? "no_stream" : history.version,
      context,
      wakeSourceContextName: "channels",
      events: [
        {
          eventType: "channels.channel-reconciliation.due",
          payload: {
            connectionId: connection.connectionId,
            generation,
            runFingerprint,
            cadencePolicyRevision: policyRevision,
            dueAt: startedAt,
          },
        },
        {
          eventType: "channels.channel-reconciliation.started",
          payload: {
            connectionId: connection.connectionId,
            generation,
            runFingerprint,
            cadencePolicyRevision: policyRevision,
            startedAt,
          },
        },
      ],
    });
    return {
      generation,
      revision: Number(updated.rows[0].revision),
      runFingerprint,
      streamVersion: history.version + 2,
    };
  });
}

async function finishRun(
  dependencies: ChannelReconciliationRuntimeDependencies,
  connection: ReconciliationConnectionSource,
  claim: Readonly<{ generation: number; revision: number; runFingerprint: string; streamVersion: number }>,
  state: ChannelReconciliationRunResult["state"],
  counts: MutableCounts,
  clean: boolean,
  cadenceMs: number,
  completedAt: string,
  context: EventStoreContext,
): Promise<ChannelReconciliationRunResult> {
  await withPgTransaction(dependencies.db, async (db) => {
    const result = await db.query(
      `UPDATE channel_reconciliation_state SET state=$3,revision=revision+1,counts=$4::jsonb,
         next_due_at=$5,last_clean_run_at=CASE WHEN $6 THEN $7 ELSE last_clean_run_at END,updated_at=$7
       WHERE connection_id=$1 AND generation=$2 AND revision=$8 AND state='running' AND run_fingerprint=$9`,
      [
        connection.connectionId,
        claim.generation,
        state,
        JSON.stringify(counts),
        new Date(Date.parse(completedAt) + cadenceMs).toISOString(),
        clean,
        completedAt,
        claim.revision,
        claim.runFingerprint,
      ],
    );
    if (Number(result.rowCount ?? 0) !== 1)
      throw new Error("Channel Reconciliation completion lost its generation fence.");
    await db.query(
      `INSERT INTO channel_reconciliation_metrics
         (connection_id,account_id,run_generation,completed_at,run_state,clean,counts)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [
        connection.connectionId,
        connection.accountId,
        claim.generation,
        completedAt,
        state,
        clean,
        JSON.stringify(counts),
      ],
    );
    await dependencies.eventStore.appendToStreamInTransaction(db, {
      streamId: runStreamId(connection.connectionId),
      expectedVersion: claim.streamVersion,
      context,
      wakeSourceContextName: "channels",
      events: [
        {
          eventType: "channels.channel-reconciliation.finished",
          payload: {
            connectionId: connection.connectionId,
            generation: claim.generation,
            runFingerprint: claim.runFingerprint,
            state,
            counts: { ...counts },
            clean,
            completedAt,
          },
        },
      ],
    });
  });
  return { connectionId: connection.connectionId, generation: claim.generation, state, counts, clean };
}

async function decideDrift(
  dependencies: ChannelReconciliationRuntimeDependencies,
  kind: "accept" | "repush",
  input: AcceptChannelDrift | RepushChannelListing,
  context: EventStoreContext,
  occurredAt: string,
): Promise<ChannelDriftDecision> {
  assertDecisionInput(input, kind);
  const commandFingerprint = digest(JSON.stringify({ kind, ...input }));
  const history = await loadDecisionHistory(dependencies, input.connectionId, input.channelListingId);
  return withPgTransaction(dependencies.db, async (db) => {
    const replay = await db.query<{ command_fingerprint: string }>(
      `SELECT command_fingerprint FROM channel_drift_decision_operations WHERE operation_id=$1`,
      [input.operationId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].command_fingerprint !== commandFingerprint) {
        throw new Error("Channel Drift Decision operation identity was reused with different input.");
      }
      if (!history.operationIds.has(input.operationId)) {
        throw new Error("Channel Drift Decision receipt does not match its event history.");
      }
      await assertDecisionProjection(db, input.connectionId, input.channelListingId, history);
      return readChannelDriftDecision(db, input);
    }
    if (history.version !== input.expectedDecisionRevision) {
      throw new Error("Channel Drift Decision revision is stale.");
    }
    const connection = await readReconciliationConnection(db, input.connectionId);
    if (!connection) throw new Error("Channel Drift Decision connection was not found.");
    assertAccountContext(connection, context);
    const item = await db.query<{
      classification: string;
      observed_fingerprint: string | null;
      expected_material_fingerprint: string;
      run_generation: string | number;
    }>(
      `SELECT classification,observed_fingerprint,expected_material_fingerprint,run_generation
       FROM channel_reconciliation_items WHERE connection_id=$1 AND channel_listing_id=$2 FOR UPDATE`,
      [input.connectionId, input.channelListingId],
    );
    if (!item.rows[0] || item.rows[0].classification !== "foreign-edit") {
      throw new Error("Channel Drift Decision requires a current foreign edit.");
    }
    if (kind === "accept") {
      const accept = input as AcceptChannelDrift;
      if (
        item.rows[0].observed_fingerprint !== accept.observedFingerprint ||
        item.rows[0].expected_material_fingerprint !== accept.expectedMaterialFingerprint
      ) {
        throw new Error("Channel Drift Decision fingerprints are stale.");
      }
    }
    await db.query(
      `INSERT INTO channel_drift_decisions
         (connection_id,channel_listing_id,revision,accepted_observed_fingerprint,
          accepted_expected_material_fingerprint,accepted_at_run_generation,repush_requested,last_operation_id,updated_at)
       VALUES ($1,$2,0,NULL,NULL,NULL,false,NULL,$3) ON CONFLICT DO NOTHING`,
      [input.connectionId, input.channelListingId, occurredAt],
    );
    await assertDecisionProjection(db, input.connectionId, input.channelListingId, history);
    const eventType = kind === "accept" ? "channels.channel-drift.accepted" : "channels.channel-drift.repush-requested";
    const eventPayload =
      kind === "accept" ? { ...input, acceptedAtRunGeneration: Number(item.rows[0].run_generation) } : { ...input };
    await dependencies.eventStore.appendToStreamInTransaction(db, {
      streamId: decisionStreamId(input.connectionId, input.channelListingId),
      expectedVersion: history.version === 0 ? "no_stream" : history.version,
      context,
      wakeSourceContextName: "channels",
      events: [{ eventType, payload: eventPayload }],
    });
    const nextRevision = history.version + 1;
    const updated =
      kind === "accept"
        ? await db.query(
            `UPDATE channel_drift_decisions SET revision=$4,accepted_observed_fingerprint=$5,
               accepted_expected_material_fingerprint=$6,accepted_at_run_generation=$7,
               repush_requested=false,last_operation_id=$8,updated_at=$9
             WHERE connection_id=$1 AND channel_listing_id=$2 AND revision=$3`,
            [
              input.connectionId,
              input.channelListingId,
              input.expectedDecisionRevision,
              nextRevision,
              (input as AcceptChannelDrift).observedFingerprint,
              (input as AcceptChannelDrift).expectedMaterialFingerprint,
              item.rows[0].run_generation,
              input.operationId,
              occurredAt,
            ],
          )
        : await db.query(
            `UPDATE channel_drift_decisions SET revision=$4,accepted_observed_fingerprint=NULL,
               accepted_expected_material_fingerprint=NULL,accepted_at_run_generation=NULL,
               repush_requested=true,last_operation_id=$5,updated_at=$6
             WHERE connection_id=$1 AND channel_listing_id=$2 AND revision=$3`,
            [
              input.connectionId,
              input.channelListingId,
              input.expectedDecisionRevision,
              nextRevision,
              input.operationId,
              occurredAt,
            ],
          );
    if (Number(updated.rowCount ?? 0) !== 1) throw new Error("Channel Drift Decision revision is stale.");
    await db.query(
      `INSERT INTO channel_drift_decision_operations
         (operation_id,connection_id,channel_listing_id,command_kind,command_fingerprint,resulting_revision,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.operationId,
        input.connectionId,
        input.channelListingId,
        kind,
        commandFingerprint,
        nextRevision,
        occurredAt,
      ],
    );
    return readChannelDriftDecision(db, input);
  });
}

function resolveObserved(
  listing: ReconciliationExpectedListing,
  observed: ReadonlyMap<string, ChannelStateLineV1>,
): ChannelDriftObservationV1["observed"] {
  if (!listing.externalListingId) return { present: false };
  const item = observed.get(externalIdentity(listing.externalListingId, listing.externalOfferId));
  return item
    ? {
        present: true,
        revision: item.revision,
        price: item.price,
        quantity: item.quantity,
        fingerprint: item.fingerprint,
      }
    : { present: false };
}

function indexObservedState(items: readonly ChannelStateLineV1[]): Map<string, ChannelStateLineV1> {
  return new Map(items.map((item) => [externalIdentity(item.externalListingId, item.externalOfferId), item]));
}

function externalIdentity(listingId: string, offerId: string | null): string {
  return `${listingId}\0${offerId ?? ""}`;
}

async function writeReconciliationItem(
  db: PgQueryable,
  listing: ReconciliationExpectedListing,
  generation: number,
  classification: ReturnType<typeof classifyChannelDrift>,
  observed: ChannelDriftObservationV1["observed"],
  updatedAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO channel_reconciliation_items
       (connection_id,channel_listing_id,listing_id,run_generation,classification,observed_fingerprint,
        expected_material_fingerprint,settled,updated_at,revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
     ON CONFLICT (connection_id,channel_listing_id) DO UPDATE SET listing_id=EXCLUDED.listing_id,
       run_generation=CASE
         WHEN channel_reconciliation_items.classification=EXCLUDED.classification
          AND channel_reconciliation_items.observed_fingerprint IS NOT DISTINCT FROM EXCLUDED.observed_fingerprint
          AND channel_reconciliation_items.expected_material_fingerprint=EXCLUDED.expected_material_fingerprint
          AND channel_reconciliation_items.settled=EXCLUDED.settled
         THEN channel_reconciliation_items.run_generation ELSE EXCLUDED.run_generation END,
       classification=EXCLUDED.classification,
       observed_fingerprint=EXCLUDED.observed_fingerprint,
       expected_material_fingerprint=EXCLUDED.expected_material_fingerprint,settled=EXCLUDED.settled,
       updated_at=EXCLUDED.updated_at,revision=channel_reconciliation_items.revision+1
     WHERE channel_reconciliation_items.run_generation < EXCLUDED.run_generation`,
    [
      listing.connectionId,
      listing.channelListingId,
      listing.listingId,
      generation,
      classification,
      observed.present ? observed.fingerprint : null,
      listing.expectedMaterialFingerprint,
      classification === "in-sync" || classification === "repairable",
      updatedAt,
    ],
  );
}

async function recordSaleLine(
  dependencies: ChannelReconciliationRuntimeDependencies,
  connection: ReconciliationConnectionSource,
  line: ChannelSaleLineV1,
  generation: number,
  backdatingAttentionAfterMs: number,
  now: string,
): Promise<Readonly<{ gap: boolean; structural: boolean }>> {
  const saleKeyFingerprint = digest(JSON.stringify(line.saleKey));
  const receipt = await dependencies.db.query(
    `SELECT 1 FROM channel_recorded_sale_receipts WHERE connection_id=$1 AND sale_key_fingerprint=$2`,
    [connection.connectionId, saleKeyFingerprint],
  );
  if (receipt.rows.length > 0) return { gap: false, structural: false };
  await openGap(dependencies.db, connection.connectionId, saleKeyFingerprint, generation, now);
  const target = await resolveChannelExternalSaleTarget(dependencies.db, {
    connectionId: connection.connectionId,
    externalListingId: line.externalListingId,
    externalOfferId: line.externalOfferId,
  });
  if (target.kind === "unmappable") {
    await writeFinding(
      dependencies.db,
      connection.connectionId,
      `sale-${saleKeyFingerprint}`,
      generation,
      "unmappable-sale",
      null,
      saleKeyFingerprint,
      target.reason,
      now,
    );
    await leaveGapOpen(dependencies.db, connection.connectionId, saleKeyFingerprint, target.reason, generation, now);
    return { gap: true, structural: true };
  }
  const outcome = await dependencies.channelSaleRecorder({
    accountId: target.accountId,
    inventoryItemId: target.inventoryItemId,
    storageLocationId: target.storageLocationId,
    saleKey: line.saleKey,
    requestedQuantity: line.requestedQuantity,
    ...(line.unitPriceAmount !== undefined ? { unitPriceAmount: line.unitPriceAmount } : {}),
    ...(line.currencyCode !== undefined ? { currencyCode: line.currencyCode } : {}),
    ...(line.soldAt !== undefined ? { soldAt: line.soldAt } : {}),
    connectionAuditReference: connection.connectionId,
  });
  if (!("status" in outcome) || outcome.status !== "committed") {
    const reason = "code" in outcome ? outcome.code : "recording-refused";
    await leaveGapOpen(dependencies.db, connection.connectionId, saleKeyFingerprint, reason, generation, now);
    return { gap: true, structural: false };
  }
  await closeFinding(dependencies.db, connection.connectionId, `sale-${saleKeyFingerprint}`, now);
  await closeGap(dependencies.db, connection.connectionId, saleKeyFingerprint, generation, now);
  if (line.soldAt && Date.parse(now) - Date.parse(line.soldAt) >= backdatingAttentionAfterMs) {
    await writeFinding(
      dependencies.db,
      connection.connectionId,
      `backdated-${saleKeyFingerprint}`,
      generation,
      "backdated-sale",
      target.channelListingId,
      saleKeyFingerprint,
      "backdated-sale-recorded",
      now,
    );
  }
  return { gap: true, structural: false };
}

async function openGap(db: PgQueryable, connectionId: string, fingerprint: string, generation: number, now: string) {
  await db.query(
    `INSERT INTO channel_missed_sale_gaps
       (connection_id,sale_key_fingerprint,first_seen_generation,last_seen_generation,open,safe_reason,updated_at,revision)
     VALUES ($1,$2,$3,$3,true,NULL,$4,1) ON CONFLICT DO NOTHING`,
    [connectionId, fingerprint, generation, now],
  );
}

async function leaveGapOpen(
  db: PgQueryable,
  connectionId: string,
  fingerprint: string,
  reason: string,
  generation: number,
  now: string,
) {
  const current = await db.query<{ revision: string | number }>(
    `SELECT revision FROM channel_missed_sale_gaps WHERE connection_id=$1 AND sale_key_fingerprint=$2`,
    [connectionId, fingerprint],
  );
  await db.query(
    `UPDATE channel_missed_sale_gaps SET last_seen_generation=$3,open=true,safe_reason=$4,updated_at=$5,revision=revision+1
     WHERE connection_id=$1 AND sale_key_fingerprint=$2 AND revision=$6`,
    [connectionId, fingerprint, generation, reason.slice(0, 128), now, current.rows[0]!.revision],
  );
}

async function closeGap(db: PgQueryable, connectionId: string, fingerprint: string, generation: number, now: string) {
  const current = await db.query<{ revision: string | number }>(
    `SELECT revision FROM channel_missed_sale_gaps WHERE connection_id=$1 AND sale_key_fingerprint=$2`,
    [connectionId, fingerprint],
  );
  const updated = await db.query(
    `UPDATE channel_missed_sale_gaps SET last_seen_generation=$3,open=false,safe_reason=NULL,updated_at=$4,revision=revision+1
     WHERE connection_id=$1 AND sale_key_fingerprint=$2 AND revision=$5`,
    [connectionId, fingerprint, generation, now, current.rows[0]!.revision],
  );
  if (Number(updated.rowCount ?? 0) !== 1) throw new Error("Missed-Sale Gap close lost its revision fence.");
  await db.query(
    `INSERT INTO channel_recorded_sale_receipts (connection_id,sale_key_fingerprint,recorded_at)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [connectionId, fingerprint, now],
  );
  await closeFinding(db, connectionId, `gap-${fingerprint}`, now);
}

async function writeFinding(
  db: PgQueryable,
  connectionId: string,
  findingId: string,
  generation: number,
  kind: "unmappable-sale" | "backdated-sale" | "unmapped-channel-state" | "persistent-sale-gap",
  channelListingId: string | null,
  fingerprint: string,
  safeReason: string,
  now: string,
) {
  await db.query(
    `INSERT INTO channel_reconciliation_findings
       (connection_id,finding_id,run_generation,kind,channel_listing_id,fingerprint,open,safe_reason,updated_at,revision)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,1)
     ON CONFLICT (connection_id,finding_id) DO UPDATE SET run_generation=CASE
       WHEN channel_reconciliation_findings.kind=EXCLUDED.kind
        AND channel_reconciliation_findings.channel_listing_id IS NOT DISTINCT FROM EXCLUDED.channel_listing_id
        AND channel_reconciliation_findings.fingerprint=EXCLUDED.fingerprint
        AND channel_reconciliation_findings.open
       THEN channel_reconciliation_findings.run_generation ELSE EXCLUDED.run_generation END,
       kind=EXCLUDED.kind,channel_listing_id=EXCLUDED.channel_listing_id,fingerprint=EXCLUDED.fingerprint,
       open=true,safe_reason=EXCLUDED.safe_reason,updated_at=EXCLUDED.updated_at,
       revision=channel_reconciliation_findings.revision+1
     WHERE channel_reconciliation_findings.run_generation < EXCLUDED.run_generation`,
    [connectionId, findingId, generation, kind, channelListingId, fingerprint, safeReason.slice(0, 128), now],
  );
}

async function ensurePersistentGapFinding(
  db: PgQueryable,
  connectionId: string,
  fingerprint: string,
  generation: number,
  now: string,
) {
  const existing = await db.query(
    `SELECT 1 FROM channel_reconciliation_findings
     WHERE connection_id=$1 AND fingerprint=$2 AND open=true LIMIT 1`,
    [connectionId, fingerprint],
  );
  if (existing.rows.length > 0) return;
  await writeFinding(
    db,
    connectionId,
    `gap-${fingerprint}`,
    generation,
    "persistent-sale-gap",
    null,
    fingerprint,
    "missed-sale-gap-persistent",
    now,
  );
}

async function closeTransientFindings(
  db: PgQueryable,
  connectionId: string,
  generation: number,
  completeState: boolean,
  now: string,
) {
  await db.query(
    `UPDATE channel_reconciliation_findings SET open=false,updated_at=$3,revision=revision+1
     WHERE connection_id=$1 AND open=true AND run_generation < $2
       AND (kind='backdated-sale' OR ($4 AND kind='unmapped-channel-state'))`,
    [connectionId, generation, now, completeState],
  );
}

async function closeFinding(db: PgQueryable, connectionId: string, findingId: string, now: string) {
  const current = await db.query<{ revision: string | number }>(
    `SELECT revision FROM channel_reconciliation_findings
     WHERE connection_id=$1 AND finding_id=$2 AND open=true`,
    [connectionId, findingId],
  );
  if (!current.rows[0]) return;
  await db.query(
    `UPDATE channel_reconciliation_findings SET open=false,updated_at=$3,revision=revision+1
     WHERE connection_id=$1 AND finding_id=$2 AND revision=$4 AND open=true`,
    [connectionId, findingId, now, current.rows[0].revision],
  );
}

async function countOpenFindings(db: PgQueryable, connectionId: string): Promise<number> {
  const result = await db.query<{ count: string | number }>(
    `SELECT
       (SELECT COUNT(*) FROM channel_reconciliation_findings WHERE connection_id=$1 AND open) +
       (SELECT COUNT(*) FROM channel_missed_sale_gaps WHERE connection_id=$1 AND open) AS count`,
    [connectionId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function readPriorAttentionState(
  db: PgQueryable,
  connectionId: string,
): Promise<
  Readonly<{
    count: number;
    allForeign: boolean;
    channelListingIds: readonly string[];
    fingerprint: string;
  }>
> {
  const items = await db.query<{ channel_listing_id: string; classification: string; fingerprint: string }>(
    `SELECT channel_listing_id,classification,COALESCE(observed_fingerprint,expected_material_fingerprint) AS fingerprint
     FROM channel_reconciliation_items
     WHERE connection_id=$1 AND classification IN ('foreign-edit','structural') AND settled=false
     ORDER BY channel_listing_id LIMIT 1001`,
    [connectionId],
  );
  const findings = await db.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM channel_reconciliation_findings WHERE connection_id=$1 AND open
     ORDER BY finding_id LIMIT 1001`,
    [connectionId],
  );
  const fingerprints = [...items.rows.map((row) => row.fingerprint), ...findings.rows.map((row) => row.fingerprint)];
  return {
    count: fingerprints.length,
    allForeign: findings.rows.length === 0 && items.rows.every((row) => row.classification === "foreign-edit"),
    channelListingIds: items.rows.map((row) => row.channel_listing_id),
    fingerprint: digest(fingerprints.join("\0")),
  };
}

async function allPriorForeignEditsAccepted(db: PgQueryable, channelListingIds: readonly string[]): Promise<boolean> {
  if (channelListingIds.length === 0) return false;
  const result = await db.query<{ count: string | number }>(
    `SELECT COUNT(*)::integer AS count FROM channel_drift_decisions
     WHERE channel_listing_id=ANY($1::text[]) AND accepted_observed_fingerprint IS NOT NULL`,
    [channelListingIds],
  );
  return Number(result.rows[0]?.count ?? 0) === channelListingIds.length;
}

async function writeAttentionResolution(
  db: PgQueryable,
  connectionId: string,
  generation: number,
  fingerprint: string,
  resolution: "handled-on-channel" | "recovered-automatically",
  resolvedAt: string,
) {
  await db.query(
    `INSERT INTO channel_reconciliation_attention_resolutions
       (connection_id,run_generation,fingerprint,resolution,resolved_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [connectionId, generation, fingerprint, resolution, resolvedAt],
  );
}

async function readPersistentGapFingerprints(
  db: PgQueryable,
  connectionId: string,
  generation: number,
  persistenceRuns: number,
): Promise<readonly string[]> {
  const result = await db.query<{ sale_key_fingerprint: string }>(
    `SELECT sale_key_fingerprint FROM channel_missed_sale_gaps
     WHERE connection_id=$1 AND open=true AND ($2-first_seen_generation+1) >= $3
     ORDER BY sale_key_fingerprint LIMIT 1000`,
    [connectionId, generation, persistenceRuns],
  );
  return result.rows.map((row) => row.sale_key_fingerprint);
}

async function writeHealthObservation(db: PgQueryable, observation: ChannelHealthObservationV1): Promise<void> {
  const inserted = await db.query(
    `INSERT INTO channel_reconciliation_health_observations
       (source_work_id,source_attempt,result_ordinal,payload,occurred_at)
     VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING source_work_id`,
    [
      observation.sourceWorkId,
      observation.sourceAttempt,
      observation.resultOrdinal,
      JSON.stringify(observation),
      observation.occurredAt,
    ],
  );
  if (Number(inserted.rowCount ?? 0) === 1) return;
  const existing = await db.query<{ matches: boolean }>(
    `SELECT payload=$4::jsonb AND occurred_at=$5::timestamptz AS matches
     FROM channel_reconciliation_health_observations
     WHERE source_work_id=$1 AND source_attempt=$2 AND result_ordinal=$3`,
    [
      observation.sourceWorkId,
      observation.sourceAttempt,
      observation.resultOrdinal,
      JSON.stringify(observation),
      observation.occurredAt,
    ],
  );
  if (existing.rows[0]?.matches !== true) {
    throw new Error("Conflicting Channel Reconciliation health terminal failed closed.");
  }
}

type RunHistory = Readonly<{
  version: number;
  generation: number;
  state: "idle" | "due" | ChannelReconciliationRunResult["state"] | "running";
  runFingerprint: string | null;
}>;

async function loadRunHistory(
  dependencies: ChannelReconciliationRuntimeDependencies,
  connectionId: string,
): Promise<RunHistory> {
  const events = await readCompleteStream(dependencies.eventStore, {
    streamId: runStreamId(connectionId),
    maxEvents: 10_000,
  });
  let state: RunHistory["state"] = "idle";
  let generation = 0;
  let runFingerprint: string | null = null;
  for (const event of events) {
    if (event.eventType === "channels.channel-reconciliation.due") {
      if (state === "running" || state === "due") invalidRunHistory("a run became due while another run was active");
      const payload = closedEventPayload(event, [
        "cadencePolicyRevision",
        "connectionId",
        "dueAt",
        "generation",
        "runFingerprint",
      ]);
      const nextGeneration = positiveEventInteger(payload.generation, "generation");
      const policyRevision = nonNegativeEventInteger(payload.cadencePolicyRevision, "cadencePolicyRevision");
      const fingerprint = eventDigest(payload.runFingerprint, "runFingerprint");
      if (payload.connectionId !== connectionId || nextGeneration !== generation + 1) {
        invalidRunHistory("a due event has the wrong identity or generation");
      }
      if (fingerprint !== digest(`${connectionId}\0${nextGeneration}\0${policyRevision}`)) {
        invalidRunHistory("a due event has the wrong run fingerprint");
      }
      eventInstant(payload.dueAt, "dueAt");
      generation = nextGeneration;
      runFingerprint = fingerprint;
      state = "due";
      continue;
    }
    if (event.eventType === "channels.channel-reconciliation.started") {
      if (state !== "due" || runFingerprint === null) invalidRunHistory("a run started without becoming due");
      const payload = closedEventPayload(event, [
        "cadencePolicyRevision",
        "connectionId",
        "generation",
        "runFingerprint",
        "startedAt",
      ]);
      const nextGeneration = positiveEventInteger(payload.generation, "generation");
      const policyRevision = nonNegativeEventInteger(payload.cadencePolicyRevision, "cadencePolicyRevision");
      const fingerprint = eventDigest(payload.runFingerprint, "runFingerprint");
      if (payload.connectionId !== connectionId || nextGeneration !== generation) {
        invalidRunHistory("a start event has the wrong identity or generation");
      }
      if (fingerprint !== digest(`${connectionId}\0${nextGeneration}\0${policyRevision}`)) {
        invalidRunHistory("a start event has the wrong run fingerprint");
      }
      eventInstant(payload.startedAt, "startedAt");
      state = "running";
      continue;
    }
    if (event.eventType === "channels.channel-reconciliation.finished") {
      if (state !== "running" || runFingerprint === null) invalidRunHistory("a run finished without an active start");
      const payload = closedEventPayload(event, [
        "clean",
        "completedAt",
        "connectionId",
        "counts",
        "generation",
        "runFingerprint",
        "state",
      ]);
      if (
        payload.connectionId !== connectionId ||
        positiveEventInteger(payload.generation, "generation") !== generation ||
        eventDigest(payload.runFingerprint, "runFingerprint") !== runFingerprint
      ) {
        invalidRunHistory("a finish event does not match its active run");
      }
      if (payload.state !== "completed" && payload.state !== "bounded-unknown" && payload.state !== "held") {
        invalidRunHistory("a finish event has an invalid terminal state");
      }
      if (typeof payload.clean !== "boolean") invalidRunHistory("a finish event has an invalid clean flag");
      validateEventCounts(payload.counts);
      eventInstant(payload.completedAt, "completedAt");
      state = payload.state;
      continue;
    }
    invalidRunHistory("an unexpected event type is present");
  }
  return { version: events.length, generation, state, runFingerprint };
}

type DecisionHistory = Readonly<{
  version: number;
  accepted: AcceptedChannelDrift | null;
  repushRequested: boolean;
  lastOperationId: string | null;
  operationIds: ReadonlySet<string>;
}>;

async function loadDecisionHistory(
  dependencies: ChannelReconciliationRuntimeDependencies,
  connectionId: string,
  channelListingId: string,
): Promise<DecisionHistory> {
  const events = await readCompleteStream(dependencies.eventStore, {
    streamId: decisionStreamId(connectionId, channelListingId),
    maxEvents: 10_000,
  });
  let accepted: AcceptedChannelDrift | null = null;
  let repushRequested = false;
  let lastOperationId: string | null = null;
  const operationIds = new Set<string>();
  for (const event of events) {
    if (event.eventType === "channels.channel-drift.accepted") {
      const payload = closedEventPayload(event, [
        "acceptedAtRunGeneration",
        "channelListingId",
        "connectionId",
        "expectedDecisionRevision",
        "expectedMaterialFingerprint",
        "observedFingerprint",
        "operationId",
      ]);
      validateDecisionEventBase(payload, event, connectionId, channelListingId);
      const operationId = eventText(payload.operationId, "operationId");
      if (operationIds.has(operationId)) invalidDecisionHistory("a command operation is repeated");
      operationIds.add(operationId);
      accepted = {
        observedFingerprint: eventDigest(payload.observedFingerprint, "observedFingerprint"),
        expectedMaterialFingerprint: eventDigest(payload.expectedMaterialFingerprint, "expectedMaterialFingerprint"),
        acceptedAtRunGeneration: positiveEventInteger(payload.acceptedAtRunGeneration, "acceptedAtRunGeneration"),
      };
      repushRequested = false;
      lastOperationId = operationId;
      continue;
    }
    if (event.eventType === "channels.channel-drift.repush-requested") {
      const payload = closedEventPayload(event, [
        "channelListingId",
        "connectionId",
        "expectedDecisionRevision",
        "operationId",
      ]);
      validateDecisionEventBase(payload, event, connectionId, channelListingId);
      const operationId = eventText(payload.operationId, "operationId");
      if (operationIds.has(operationId)) invalidDecisionHistory("a command operation is repeated");
      operationIds.add(operationId);
      accepted = null;
      repushRequested = true;
      lastOperationId = operationId;
      continue;
    }
    if (event.eventType === "channels.channel-drift.repush-enqueued") {
      const payload = closedEventPayload(event, [
        "channelListingId",
        "connectionId",
        "expectedDecisionRevision",
        "operationId",
      ]);
      validateDecisionEventBase(payload, event, connectionId, channelListingId);
      const operationId = eventText(payload.operationId, "operationId");
      if (!repushRequested || lastOperationId !== operationId || !operationIds.has(operationId)) {
        invalidDecisionHistory("a repush completion does not match an active request");
      }
      repushRequested = false;
      continue;
    }
    invalidDecisionHistory("an unexpected event type is present");
  }
  return { version: events.length, accepted, repushRequested, lastOperationId, operationIds };
}

async function assertDecisionProjection(
  db: PgQueryable,
  connectionId: string,
  channelListingId: string,
  history: DecisionHistory,
): Promise<void> {
  const result = await db.query<{
    revision: string | number;
    accepted_observed_fingerprint: string | null;
    accepted_expected_material_fingerprint: string | null;
    accepted_at_run_generation: string | number | null;
    repush_requested: boolean;
    last_operation_id: string | null;
  }>(
    `SELECT revision,accepted_observed_fingerprint,accepted_expected_material_fingerprint,
            accepted_at_run_generation,repush_requested,last_operation_id
     FROM channel_drift_decisions WHERE connection_id=$1 AND channel_listing_id=$2 FOR UPDATE`,
    [connectionId, channelListingId],
  );
  const row = result.rows[0];
  if (
    !row ||
    Number(row.revision) !== history.version ||
    row.accepted_observed_fingerprint !== (history.accepted?.observedFingerprint ?? null) ||
    row.accepted_expected_material_fingerprint !== (history.accepted?.expectedMaterialFingerprint ?? null) ||
    (row.accepted_at_run_generation === null ? null : Number(row.accepted_at_run_generation)) !==
      (history.accepted?.acceptedAtRunGeneration ?? null) ||
    row.repush_requested !== history.repushRequested ||
    row.last_operation_id !== history.lastOperationId
  ) {
    throw new Error("Channel Drift Decision projection does not match its event history.");
  }
}

function validateDecisionEventBase(
  payload: Record<string, unknown>,
  event: StoredEvent,
  connectionId: string,
  channelListingId: string,
) {
  if (payload.connectionId !== connectionId || payload.channelListingId !== channelListingId) {
    invalidDecisionHistory("an event has the wrong identity");
  }
  if (
    nonNegativeEventInteger(payload.expectedDecisionRevision, "expectedDecisionRevision") !==
    event.streamVersion - 1
  ) {
    invalidDecisionHistory("an event has the wrong expected revision");
  }
}

function closedEventPayload(event: StoredEvent, expectedKeys: readonly string[]): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Invalid ${event.eventType} event history: payload is not recursively closed.`);
  }
  return payload;
}

function validateEventCounts(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRunHistory("counts are invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(zeroCounts()).sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    invalidRunHistory("counts are not recursively closed");
  }
  for (const key of keys) nonNegativeEventInteger(record[key], `counts.${key}`);
}

function eventText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || [...value].length > 512) {
    invalidDecisionHistory(`${label} is invalid`);
  }
  return value;
}

function eventDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid reconciliation event history: ${label} is invalid.`);
  }
  return value;
}

function positiveEventInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`Invalid reconciliation event history: ${label} is invalid.`);
  return number;
}

function nonNegativeEventInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`Invalid reconciliation event history: ${label} is invalid.`);
  return number;
}

function eventInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`Invalid reconciliation event history: ${label} is invalid.`);
  }
  return value;
}

function runStreamId(connectionId: string): string {
  return `channels.channel-reconciliation-${connectionId}`;
}

function decisionStreamId(connectionId: string, channelListingId: string): string {
  return `channels.channel-drift-decision-${connectionId}-${channelListingId}`;
}

function invalidRunHistory(reason: string): never {
  throw new Error(`Invalid Channel Reconciliation Run event history: ${reason}.`);
}

function invalidDecisionHistory(reason: string): never {
  throw new Error(`Invalid Channel Drift Decision event history: ${reason}.`);
}

async function markRepushConsumed(
  dependencies: ChannelReconciliationRuntimeDependencies,
  decision: ChannelDriftDecision,
  context: EventStoreContext,
  now: string,
): Promise<void> {
  if (!decision.operationId) throw new Error("Channel Drift repush request has no operation identity.");
  const history = await loadDecisionHistory(dependencies, decision.connectionId, decision.channelListingId);
  if (!history.repushRequested || history.lastOperationId !== decision.operationId) {
    throw new Error("Channel Drift repush request does not match its event history.");
  }
  await withPgTransaction(dependencies.db, async (db) => {
    const result = await db.query(
      `UPDATE channel_drift_decisions SET revision=revision+1,repush_requested=false,updated_at=$4
       WHERE connection_id=$1 AND channel_listing_id=$2 AND revision=$3 AND repush_requested=true`,
      [decision.connectionId, decision.channelListingId, history.version, now],
    );
    if (Number(result.rowCount ?? 0) !== 1) throw new Error("Channel Drift repush request lost its revision fence.");
    await dependencies.eventStore.appendToStreamInTransaction(db, {
      streamId: decisionStreamId(decision.connectionId, decision.channelListingId),
      expectedVersion: history.version,
      context,
      wakeSourceContextName: "channels",
      events: [
        {
          eventType: "channels.channel-drift.repush-enqueued",
          payload: {
            connectionId: decision.connectionId,
            channelListingId: decision.channelListingId,
            operationId: decision.operationId,
            expectedDecisionRevision: history.version,
          },
        },
      ],
    });
  });
}

function incrementClassification(counts: MutableCounts, classification: ReturnType<typeof classifyChannelDrift>) {
  switch (classification) {
    case "in-sync":
      counts.inSync += 1;
      return;
    case "repairable":
      counts.repairable += 1;
      return;
    case "foreign-edit":
      counts.foreignEdit += 1;
      return;
    case "structural":
      counts.structural += 1;
      return;
    case "source-unavailable":
      counts.sourceUnavailable += 1;
      return;
  }
}

function assertDecisionInput(input: AcceptChannelDrift | RepushChannelListing, kind: "accept" | "repush") {
  const expectedKeys =
    kind === "accept"
      ? [
          "channelListingId",
          "connectionId",
          "expectedDecisionRevision",
          "expectedMaterialFingerprint",
          "observedFingerprint",
          "operationId",
        ]
      : ["channelListingId", "connectionId", "expectedDecisionRevision", "operationId"];
  const actualKeys = Object.keys(input).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Channel Drift Decision command is not recursively closed.");
  }
  for (const key of ["connectionId", "channelListingId", "operationId"] as const) {
    if (typeof input[key] !== "string" || input[key].length < 1 || [...input[key]].length > 512) {
      throw new Error(`Channel Drift Decision ${key} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(input.expectedDecisionRevision) || input.expectedDecisionRevision < 0) {
    throw new Error("Channel Drift Decision expected revision is invalid.");
  }
  if (kind === "accept") {
    const accept = input as AcceptChannelDrift;
    if (
      !/^[a-f0-9]{64}$/.test(accept.observedFingerprint) ||
      !/^[a-f0-9]{64}$/.test(accept.expectedMaterialFingerprint)
    ) {
      throw new Error("Channel Drift Decision fingerprints are invalid.");
    }
  }
}

function assertAccountContext(connection: ReconciliationConnectionSource, context: EventStoreContext) {
  if (String(context.audit.forAccountId) !== connection.accountId) {
    throw new Error("Channel Reconciliation context must be scoped to the connection account.");
  }
}

async function safeKillSwitch(
  resolve: ChannelReconciliationRuntimeDependencies["resolveKillSwitch"],
): Promise<ChannelOutboundKillSwitchPolicyValue | null> {
  try {
    return await resolve();
  } catch {
    return null;
  }
}

function safeSaleReason(result: ChannelSaleFetchResult): string {
  return result.kind === "bounded-unknown" ? result.reason : "hard-cap";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPositive(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}
