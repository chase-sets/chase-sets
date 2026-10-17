import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { channelSyncRunEventCodec } from "../domain/codec";
import type {
  ChannelSyncRunComposedEvent,
  ChannelSyncRunMember,
  ChannelSyncRunTransitionedEvent,
} from "../domain/contracts";
import { digestChannelSyncRunMembers } from "../domain/digest";

export function buildTcgplayerCsvProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "channels.tcgplayer-sync-run.composed": async (transport, context) => {
      const event = channelSyncRunEventCodec.decode({ eventType: transport.type, payload: transport.data });
      if (event.type !== "channels.tcgplayer-sync-run.composed") return;
      await projectChannelSyncRunComposed(resolveProjectionDb(context, db), event.data, transport.streamVersion);
    },
    "channels.tcgplayer-sync-run.transitioned": async (transport, context) => {
      const event = channelSyncRunEventCodec.decode({ eventType: transport.type, payload: transport.data });
      if (event.type !== "channels.tcgplayer-sync-run.transitioned") return;
      await projectChannelSyncRunTransitioned(
        resolveProjectionDb(context, db),
        event.data,
        transport.streamVersion,
        transport.timing.recordedAt,
      );
    },
  };
}

export async function projectChannelSyncRunComposed(
  db: PgQueryable,
  data: ChannelSyncRunComposedEvent["data"],
  streamVersion: number,
): Promise<void> {
  const run = data.run;
  const digest = digestChannelSyncRunMembers(run.members);
  const inserted = await db.query(
    `INSERT INTO channel_sync_runs
     (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
      manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,verification_snapshot_id,
      verification_snapshot_generation,upload_attempted_at,upload_file_name,import_summary,csv_header,member_count,
      member_digest,created_at,updated_at,last_stream_version)
     VALUES ($1,0,$2,$3,'tcgplayer',$4,$5,$6,$7,$8::jsonb,'composed',$9,$10,NULL,NULL,NULL,NULL,NULL,$11::jsonb,$12,$13,$14,$14,$15)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      run.runId,
      run.sequence,
      run.connectionId,
      run.reservationId,
      run.claimant.claimantKind,
      run.claimant.claimantId,
      run.leaseExpiresAt,
      run.manualClaimLeasePolicySnapshot === null ? null : JSON.stringify(run.manualClaimLeasePolicySnapshot),
      run.basisSnapshotId,
      run.basisSnapshotGeneration,
      JSON.stringify(data.csvHeader),
      run.members.length,
      digest,
      run.createdAt,
      streamVersion,
    ],
  );
  if (inserted.rowCount === 1) {
    await insertMembers(db, run.runId, run.members);
    return;
  }
  const existing = await db.query<{
    reservation_id: string;
    member_count: number;
    member_digest: string;
    last_stream_version: string | number;
  }>("SELECT reservation_id,member_count,member_digest,last_stream_version FROM channel_sync_runs WHERE run_id=$1", [
    run.runId,
  ]);
  const row = existing.rows[0];
  if (
    !row ||
    row.reservation_id !== run.reservationId ||
    row.member_count !== run.members.length ||
    row.member_digest !== digest ||
    Number(row.last_stream_version) < streamVersion
  ) {
    throw new Error("Channel Sync Run composed projection collision.");
  }
}

export async function projectChannelSyncRunTransitioned(
  db: PgQueryable,
  data: ChannelSyncRunTransitionedEvent["data"],
  streamVersion: number,
  recordedAt: string,
): Promise<void> {
  const updated = await db.query(
    `UPDATE channel_sync_runs SET state=$5,revision=revision+1,updated_at=$6,
     upload_attempted_at=coalesce($7::timestamptz,upload_attempted_at),
     verification_snapshot_id=coalesce($8,verification_snapshot_id),
     verification_snapshot_generation=coalesce($9,verification_snapshot_generation),
     upload_file_name=coalesce($10,upload_file_name),
     import_summary=coalesce($11::jsonb,import_summary),last_stream_version=$12
     WHERE run_id=$1 AND reservation_id=$2 AND revision=$3 AND state=$4 AND last_stream_version<$12`,
    [
      data.runId,
      data.reservationId,
      data.expectedRevision,
      data.fromState,
      data.toState,
      recordedAt,
      data.uploadAttemptedAt,
      data.verificationSnapshotId,
      data.verificationSnapshotGeneration,
      data.uploadFileName,
      data.importSummary === null ? null : JSON.stringify(data.importSummary),
      streamVersion,
    ],
  );
  if (updated.rowCount === 1) return;
  const existing = await db.query<{ last_stream_version: string | number }>(
    "SELECT last_stream_version FROM channel_sync_runs WHERE run_id=$1",
    [data.runId],
  );
  if (!existing.rows[0] || Number(existing.rows[0].last_stream_version) < streamVersion) {
    throw new Error("Channel Sync Run transition projection fence did not match.");
  }
}

async function insertMembers(db: PgQueryable, runId: string, members: readonly ChannelSyncRunMember[]): Promise<void> {
  await db.query(
    `INSERT INTO channel_sync_run_rows
     (run_id,operation_id,ordinal,reservation_id,attempt_id,claim_generation,channel_listing_id,listing_id,
      desired_state_sequence,listing_revision,payload_digest,member_kind,external_key,condition_text,basis_snapshot_id,
      basis_snapshot_generation,basis_total_quantity,basis_price_amount_minor,target_quantity,target_price_amount_minor,
      csv_row_json,refusal_reason,mapping_dimension,mapping_source_key,provider_action)
     SELECT $1,row.operation_id,row.ordinal,row.reservation_id,row.attempt_id,row.claim_generation,row.channel_listing_id,
            row.listing_id,row.desired_state_sequence,row.listing_revision,row.payload_digest,row.member_kind,row.external_key,
            row.condition_text,row.basis_snapshot_id,row.basis_snapshot_generation,row.basis_total_quantity,
            row.basis_price_amount_minor,row.target_quantity,row.target_price_amount_minor,row.csv_row_json,
            row.refusal_reason,row.mapping_dimension,row.mapping_source_key,row.provider_action
     FROM jsonb_to_recordset($2::jsonb) AS row(
       operation_id text,ordinal integer,reservation_id text,attempt_id text,claim_generation bigint,
       channel_listing_id text,listing_id text,desired_state_sequence bigint,listing_revision bigint,payload_digest text,
       member_kind text,external_key text,condition_text text,basis_snapshot_id text,basis_snapshot_generation bigint,
       basis_total_quantity integer,basis_price_amount_minor bigint,target_quantity integer,target_price_amount_minor bigint,
       csv_row_json jsonb,refusal_reason text,mapping_dimension text,mapping_source_key text,provider_action text
     )`,
    [
      runId,
      JSON.stringify(
        members.map((member) => ({
          operation_id: member.operationId,
          ordinal: member.ordinal,
          reservation_id: member.reservationId,
          attempt_id: member.attemptId,
          claim_generation: member.claimGeneration,
          channel_listing_id: member.channelListingId,
          listing_id: member.listingId,
          desired_state_sequence: member.desiredStateSequence,
          listing_revision: member.listingRevision,
          payload_digest: member.payloadDigest,
          member_kind: member.memberKind,
          external_key: member.externalKey,
          condition_text: member.conditionText,
          basis_snapshot_id: member.basisSnapshotId,
          basis_snapshot_generation: member.basisSnapshotGeneration,
          basis_total_quantity: member.basisTotalQuantity,
          basis_price_amount_minor: member.basisPriceAmountMinor,
          target_quantity: member.targetQuantity,
          target_price_amount_minor: member.targetPriceAmountMinor,
          csv_row_json: member.csvRow,
          refusal_reason: member.refusalReason,
          mapping_dimension: member.mappingDimension,
          mapping_source_key: member.mappingSourceKey,
          provider_action: member.memberKind === "already-satisfied" ? member.providerAction : null,
        })),
      ),
    ],
  );
}
