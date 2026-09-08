import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildChannelListingStateProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "channels.channel-publication-configuration.settings-replaced": async (event) => {
      const data = record(event.data);
      const settings = record(data.settings);
      await db.query(
        `INSERT INTO channels_connection_publication_settings
           (connection_id,title_prefix,title_suffix,description_footer,category_allowlist,excluded_listing_ids,updated_at,last_stream_version)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
         ON CONFLICT (connection_id) DO UPDATE SET title_prefix=EXCLUDED.title_prefix,title_suffix=EXCLUDED.title_suffix,
           description_footer=EXCLUDED.description_footer,category_allowlist=EXCLUDED.category_allowlist,
           excluded_listing_ids=EXCLUDED.excluded_listing_ids,updated_at=EXCLUDED.updated_at,
           last_stream_version=EXCLUDED.last_stream_version
         WHERE channels_connection_publication_settings.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.connectionId,
          settings.titlePrefix,
          settings.titleSuffix,
          settings.descriptionFooter,
          JSON.stringify(settings.categoryAllowlist),
          JSON.stringify(settings.excludedListingIds),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.channel-publication-configuration.mapping-candidate-recorded": async (event) => {
      const data = record(event.data);
      for (const candidateValue of array(data.candidates)) {
        const candidate = record(candidateValue);
        await db.query(
          `INSERT INTO channels_channel_mappings
             (connection_id,dimension,source_key,target_key,confidence_tier,review_status,provenance,evidence,updated_at,last_stream_version)
           VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7::jsonb,$8,$9)
           ON CONFLICT (connection_id,dimension,source_key) DO NOTHING`,
          [
            data.connectionId,
            candidate.dimension,
            candidate.sourceKey,
            candidate.proposedTargetKey,
            candidate.confidenceTier,
            data.provenance,
            JSON.stringify(candidate.evidence),
            event.timing.recordedAt,
            event.streamVersion,
          ],
        );
      }
    },
    "channels.channel-publication-configuration.mapping-review-decided": async (event) => {
      const data = record(event.data);
      await db.query(
        `UPDATE channels_channel_mappings SET target_key=$4,confidence_tier=$5,review_status=$6,
           provenance='operator',evidence=$7::jsonb,updated_at=$8,last_stream_version=$9
         WHERE connection_id=$1 AND dimension=$2 AND source_key=$3 AND last_stream_version < $9`,
        [
          data.connectionId,
          data.dimension,
          data.sourceKey,
          data.targetKey,
          data.confidenceTier,
          data.reviewStatus,
          JSON.stringify(data.evidence),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.channel-listing.desired-state-changed": async (event) => {
      const data = record(event.data);
      if (data.desiredStateSequence !== event.streamVersion) {
        throw new Error("Channel Listing Desired State sequence must equal the committed Link stream version.");
      }
      await db.query(
        `INSERT INTO channels_channel_listing_links (
           connection_id,listing_id,channel_listing_id,last_desired_state_sequence,last_desired_listing_revision,
           last_desired_state_hash,last_desired_intent,last_desired_payload,publish_state,blocking_reason_codes,
           failure_reason,updated_at,last_stream_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending','[]'::jsonb,NULL,$9,$10)
         ON CONFLICT (connection_id,listing_id) DO UPDATE SET
           last_desired_state_sequence=EXCLUDED.last_desired_state_sequence,
           last_desired_listing_revision=EXCLUDED.last_desired_listing_revision,
           last_desired_state_hash=EXCLUDED.last_desired_state_hash,last_desired_intent=EXCLUDED.last_desired_intent,
           last_desired_payload=EXCLUDED.last_desired_payload,publish_state='pending',blocking_reason_codes='[]'::jsonb,
           failure_reason=NULL,updated_at=EXCLUDED.updated_at,last_stream_version=EXCLUDED.last_stream_version
         WHERE channels_channel_listing_links.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.connectionId,
          data.listingId,
          data.channelListingId,
          data.desiredStateSequence,
          data.listingRevision,
          data.desiredStateHash,
          data.intent,
          JSON.stringify(data),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.channel-listing.publication-blocked": async (event) => {
      const data = record(event.data);
      await db.query(
        `INSERT INTO channels_channel_listing_links
           (connection_id,listing_id,channel_listing_id,publish_state,blocking_reason_codes,failure_reason,updated_at,last_stream_version)
         VALUES ($1,$2,$3,'blocked',$4::jsonb,NULL,$5,$6)
         ON CONFLICT (connection_id,listing_id) DO UPDATE SET publish_state='blocked',
           blocking_reason_codes=EXCLUDED.blocking_reason_codes,failure_reason=NULL,
           updated_at=EXCLUDED.updated_at,last_stream_version=EXCLUDED.last_stream_version
         WHERE channels_channel_listing_links.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.connectionId,
          data.listingId,
          data.channelListingId,
          JSON.stringify(data.reasons),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.channel-listing.publication-recorded": async (event) => {
      const data = record(event.data);
      const outcome = record(data.outcome);
      const binding = JSON.stringify({
        channelListingId: data.channelListingId,
        sequence: data.reportedDesiredStateSequence,
        listingRevision: data.reportedListingRevision,
        desiredStateHash: data.reportedDesiredStateHash,
      });
      if (outcome.kind === "succeeded" && data.adoption === "identity-adopted") {
        await db.query(
          `UPDATE channels_channel_listing_links SET
             external_listing_id=COALESCE(external_listing_id,$3),external_offer_id=COALESCE(external_offer_id,$4),
             provider_revision=COALESCE(provider_revision,$5),operation_bindings=operation_bindings || jsonb_build_object($2::text,$6::jsonb),
             updated_at=$7,last_stream_version=$8
           WHERE channel_listing_id=$1 AND last_stream_version < $8`,
          [
            data.channelListingId,
            data.operationId,
            outcome.externalListingId,
            outcome.externalOfferId ?? null,
            outcome.providerRevision ?? null,
            binding,
            event.timing.recordedAt,
            event.streamVersion,
          ],
        );
        return;
      }
      if (outcome.kind === "succeeded") {
        await db.query(
          `UPDATE channels_channel_listing_links SET
             external_listing_id=$3,external_offer_id=COALESCE($4,external_offer_id),
             provider_revision=COALESCE($5,provider_revision),
             last_pushed_listing_revision=CASE WHEN last_desired_intent='delist' THEN last_pushed_listing_revision ELSE last_desired_listing_revision END,
             last_pushed_price_amount_minor=CASE WHEN last_desired_intent='delist' THEN last_pushed_price_amount_minor ELSE (last_desired_payload->'draft'->'price'->>'amountMinor')::bigint END,
             last_pushed_price_currency=CASE WHEN last_desired_intent='delist' THEN last_pushed_price_currency ELSE last_desired_payload->'draft'->'price'->>'currency' END,
             last_pushed_quantity=CASE WHEN last_desired_intent='delist' THEN 0 ELSE (last_desired_payload->'draft'->>'quantity')::integer END,
             publish_state=CASE WHEN last_desired_intent='delist' THEN 'delisted' ELSE 'published' END,
             blocking_reason_codes='[]'::jsonb,failure_reason=NULL,
             operation_bindings=operation_bindings || jsonb_build_object($2::text,$6::jsonb),updated_at=$7,last_stream_version=$8
           WHERE channel_listing_id=$1 AND last_stream_version < $8`,
          [
            data.channelListingId,
            data.operationId,
            outcome.externalListingId,
            outcome.externalOfferId ?? null,
            outcome.providerRevision ?? null,
            binding,
            event.timing.recordedAt,
            event.streamVersion,
          ],
        );
        return;
      }
      await db.query(
        `UPDATE channels_channel_listing_links SET publish_state='failed',blocking_reason_codes='[]'::jsonb,
           failure_reason=$3,operation_bindings=operation_bindings || jsonb_build_object($2::text,$4::jsonb),
           updated_at=$5,last_stream_version=$6
         WHERE channel_listing_id=$1 AND last_stream_version < $6`,
        [
          data.channelListingId,
          data.operationId,
          outcome.kind === "rejected" ? outcome.code : "outcome-unknown",
          binding,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.channel-listing-reconciliation.run-enqueued": async (event) => {
      const data = record(event.data);
      await db.query(
        `INSERT INTO channels_listing_reconciliation_runs
           (run_id,connection_id,scope,scope_key,cursor_listing_id,restart_required,processed_count,state,failure_code,attempt_count,updated_at,last_stream_version)
         VALUES ($1,$2,$3,$4,NULL,false,0,'pending',NULL,0,$5,$6)
         ON CONFLICT (run_id) DO UPDATE SET restart_required=true,updated_at=EXCLUDED.updated_at,last_stream_version=EXCLUDED.last_stream_version
         WHERE channels_listing_reconciliation_runs.last_stream_version < EXCLUDED.last_stream_version`,
        [data.runId, data.connectionId, data.scope, data.scopeKey, event.timing.recordedAt, event.streamVersion],
      );
    },
    "channels.channel-listing-reconciliation.chunk-drained": async (event) => {
      const data = record(event.data);
      await db.query(
        `UPDATE channels_listing_reconciliation_runs SET cursor_listing_id=$2,
           processed_count=CASE WHEN $2::text IS NULL AND $3=0 THEN 0 ELSE processed_count+$3 END,
           state='draining',attempt_count=attempt_count+1,
           restart_required=CASE WHEN $2::text IS NULL AND $3=0 THEN false WHEN $4 THEN restart_required ELSE false END,
           updated_at=$5,last_stream_version=$6
         WHERE run_id=$1 AND last_stream_version < $6`,
        [data.runId, data.toCursor, data.processedCount, data.remaining, event.timing.recordedAt, event.streamVersion],
      );
    },
    "channels.channel-listing-reconciliation.run-settled": async (event) => {
      const data = record(event.data);
      const outcome = record(data.outcome);
      await db.query(
        `UPDATE channels_listing_reconciliation_runs SET state=$2,failure_code=$3,
           processed_count=CASE WHEN $2='complete' THEN $4 ELSE processed_count END,
           updated_at=$5,last_stream_version=$6
         WHERE run_id=$1 AND last_stream_version < $6`,
        [
          data.runId,
          outcome.kind,
          outcome.kind === "failed" ? outcome.code : null,
          outcome.kind === "complete" ? outcome.processedCount : 0,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
