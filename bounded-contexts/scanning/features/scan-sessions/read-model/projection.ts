import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildScanSessionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const updateScan = async (event: TransportEvent, fields: Record<string, unknown>) => {
    await db.query(
      `UPDATE scanning_scan_records SET ${Object.keys(fields)
        .map((key, i) => `${key} = $${i + 2}`)
        .join(
          ", ",
        )}, updated_at = $${Object.keys(fields).length + 2}, last_stream_version = $${Object.keys(fields).length + 3} WHERE session_id = $1 AND scan_id = $${Object.keys(fields).length + 4} AND last_stream_version < $${Object.keys(fields).length + 3}`,
      [event.data.sessionId, ...Object.values(fields), event.timing.recordedAt, event.streamVersion, event.data.scanId],
    );
  };
  return {
    "scanning.scan-session.started": async (event) => {
      const d = event.data as ScanProjectionData;
      await db.query(
        `INSERT INTO scanning_scan_sessions(session_id, account_id, purpose, channel, created_at, updated_at, last_stream_version) VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (session_id) DO UPDATE SET last_stream_version=EXCLUDED.last_stream_version WHERE scanning_scan_sessions.last_stream_version < EXCLUDED.last_stream_version`,
        [d.sessionId, d.accountId, d.purpose, d.channel, event.timing.recordedAt, event.streamVersion],
      );
    },
    "scanning.scan-session.scan-captured": async (event) => {
      const d = event.data as ScanProjectionData;
      await db.query(
        `INSERT INTO scanning_scan_records(session_id,scan_id,asset_ref,status,updated_at,last_stream_version) VALUES ($1,$2,$3,'captured',$4,$5) ON CONFLICT (session_id,scan_id) DO UPDATE SET asset_ref=EXCLUDED.asset_ref,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,last_stream_version=EXCLUDED.last_stream_version WHERE scanning_scan_records.last_stream_version < EXCLUDED.last_stream_version`,
        [d.sessionId, d.scanId, d.assetRef, event.timing.recordedAt, event.streamVersion],
      );
    },
    "scanning.scan-session.scan-identified": async (event) =>
      updateScan(event, { status: "identified", candidates: JSON.stringify(event.data.candidates) }),
    "scanning.scan-session.scan-unidentified": async (event) =>
      updateScan(event, { status: "unidentified", reason: event.data.reason }),
    "scanning.scan-session.match-confirmed": async (event) => {
      await updateScan(event, {
        status: "confirmed",
        product: JSON.stringify(event.data.product),
        candidate_source: event.data.candidateSource,
      });
      await updateCounts(db, event, "confirmed");
    },
    "scanning.scan-session.match-corrected": async (event) => {
      await updateScan(event, {
        status: "corrected",
        product: JSON.stringify(event.data.product),
        candidate_source: "manual",
        rejected_candidate_ref: event.data.rejectedCandidateRef,
      });
      await updateCounts(db, event, "corrected");
    },
    "scanning.scan-session.scan-discarded": async (event) => {
      await updateScan(event, { status: "discarded", reason: event.data.reason });
      await updateCounts(db, event, "discarded");
    },
    "scanning.scan-session.completed": async (event) => {
      const d = event.data as ScanProjectionData;
      await db.query(
        `UPDATE scanning_scan_sessions SET status='completed',confirmed_count=$2,corrected_count=$3,unidentified_count=$4,discarded_count=$5,completed_at=$6,updated_at=$7,last_stream_version=$8 WHERE session_id=$1 AND last_stream_version < $8`,
        [
          d.sessionId,
          d.counts!.confirmed,
          d.counts!.corrected,
          d.counts!.unidentified,
          d.counts!.discarded,
          d.completedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
type ScanProjectionData = {
  sessionId: string;
  scanId?: string;
  accountId?: string;
  purpose?: string;
  channel?: string;
  assetRef?: string;
  candidates?: unknown;
  status?: string;
  reason?: string;
  product?: unknown;
  candidateSource?: string;
  rejectedCandidateRef?: string;
  counts?: { confirmed: number; corrected: number; unidentified: number; discarded: number };
  completedAt?: string;
};
async function updateCounts(db: PgQueryable, event: TransportEvent, kind: string) {
  const col = `${kind}_count`;
  await db.query(
    `UPDATE scanning_scan_sessions SET ${col} = ${col} + 1, updated_at=$2, last_stream_version=$3 WHERE session_id=$1 AND last_stream_version < $3`,
    [event.data.sessionId, event.timing.recordedAt, event.streamVersion],
  );
}
