import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ChannelInventorySnapshot,
  ChannelInventorySnapshotRow,
  ChannelSyncRun,
  ChannelSyncRunMember,
  ManualClaimLeasePolicySnapshot,
  TcgplayerLocalRefusalReason,
} from "../domain/contracts";
import { tcgplayerLocalRefusalReasons } from "../domain/contracts";

type RunRow = Readonly<{
  run_id: string;
  revision: string | number;
  sequence: string | number;
  connection_id: string;
  reservation_id: string;
  claimant_kind: "connector" | "manual";
  claimant_id: string;
  lease_expires_at: string | Date;
  manual_claim_lease_policy_snapshot: ManualClaimLeasePolicySnapshot | null;
  state: ChannelSyncRun["state"];
  basis_snapshot_id: string;
  basis_snapshot_generation: string | number;
  verification_snapshot_id: string | null;
  verification_snapshot_generation: string | number | null;
  upload_attempted_at: string | Date | null;
  upload_file_name: string | null;
  import_summary: ChannelSyncRun["importSummary"];
  created_at: string | Date;
  updated_at: string | Date;
  member_count: number;
  member_digest: string;
}>;

export async function readLatestSnapshotRows(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; surface: "live" | "staged" }>,
): ReturnType<typeof readSnapshotRows> {
  return readSnapshotRows(db, input);
}

export async function readSnapshotRowsById(db: PgQueryable, snapshotId: string): ReturnType<typeof readSnapshotRows> {
  const identity = await db.query<{ connection_id: string; surface: "live" | "staged" }>(
    "SELECT connection_id,surface FROM channel_inventory_snapshots WHERE snapshot_id=$1",
    [snapshotId],
  );
  const row = identity.rows[0];
  return row ? readSnapshotRows(db, { connectionId: row.connection_id, surface: row.surface, snapshotId }) : null;
}

async function readSnapshotRows(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; surface: "live" | "staged"; snapshotId?: string }>,
): Promise<Readonly<{
  snapshot: ChannelInventorySnapshot;
  rows: readonly ChannelInventorySnapshotRow[];
  membershipCompleteness:
    | Readonly<{ kind: "complete"; total: number }>
    | Readonly<{ kind: "bounded-incomplete"; reason: "parsed-row-count-mismatch" }>;
}> | null> {
  const snapshotResult = await db.query<{
    snapshot_id: string;
    snapshot_generation: string | number;
    connection_id: string;
    surface: "live" | "staged";
    parsed_row_count: number;
    ingested_at: string | Date;
    captured_at: string | Date;
    captured_at_source: "operator-declared" | "ingest";
  }>(
    `SELECT snapshot_id,snapshot_generation,connection_id,surface,parsed_row_count,ingested_at,captured_at,captured_at_source
     FROM channel_inventory_snapshots
     WHERE connection_id=$1 AND surface=$2 AND ($3::text IS NULL OR snapshot_id=$3)
     ORDER BY snapshot_generation DESC,snapshot_id COLLATE "C" DESC LIMIT 1`,
    [input.connectionId, input.surface, input.snapshotId ?? null],
  );
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) return null;
  const rows = await db.query<{
    external_key: string;
    condition_text: string | null;
    total_quantity: number;
    pending_quantity_delta: number;
    price_amount_text: string;
    price_amount_minor: string | number | null;
    reference_columns: Record<string, string>;
    row_number: number;
  }>(
    `SELECT external_key,condition_text,total_quantity,pending_quantity_delta,price_amount_text,price_amount_minor,reference_columns,row_number
     FROM channel_inventory_snapshot_rows WHERE snapshot_id=$1 ORDER BY row_number`,
    [snapshot.snapshot_id],
  );
  const mappedSnapshot: ChannelInventorySnapshot = {
    snapshotId: snapshot.snapshot_id,
    snapshotGeneration: number(snapshot.snapshot_generation),
    connectionId: snapshot.connection_id,
    providerKey: "tcgplayer",
    surface: snapshot.surface,
    parsedRowCount: snapshot.parsed_row_count,
    completeness: "unverified",
    ingestedAt: instant(snapshot.ingested_at),
    capturedAt: instant(snapshot.captured_at),
    capturedAtSource: snapshot.captured_at_source,
  };
  const mappedRows = rows.rows.map((row) => ({
    snapshotId: mappedSnapshot.snapshotId,
    snapshotGeneration: mappedSnapshot.snapshotGeneration,
    connectionId: mappedSnapshot.connectionId,
    providerKey: "tcgplayer" as const,
    surface: mappedSnapshot.surface,
    externalKey: row.external_key,
    conditionText: row.condition_text,
    totalQuantity: row.total_quantity,
    pendingQuantityDelta: row.pending_quantity_delta,
    priceAmountText: row.price_amount_text,
    priceAmountMinor: row.price_amount_minor === null ? null : number(row.price_amount_minor),
    currency: "USD" as const,
    referenceColumns: row.reference_columns,
    rowNumber: row.row_number,
    ingestedAt: mappedSnapshot.ingestedAt,
    capturedAt: mappedSnapshot.capturedAt,
    capturedAtSource: mappedSnapshot.capturedAtSource,
  }));
  return {
    snapshot: mappedSnapshot,
    rows: mappedRows,
    membershipCompleteness:
      mappedRows.length === mappedSnapshot.parsedRowCount
        ? { kind: "complete", total: mappedRows.length }
        : { kind: "bounded-incomplete", reason: "parsed-row-count-mismatch" },
  };
}

export async function readRun(db: PgQueryable, runId: string): Promise<ChannelSyncRun | null> {
  const result = await db.query<RunRow>("SELECT * FROM channel_sync_runs WHERE run_id=$1", [runId]);
  return result.rows[0] ? mapRun(db, result.rows[0]) : null;
}

export async function readChannelSyncRunByReservation(
  db: PgQueryable,
  reservationId: string,
  lock = false,
): Promise<ChannelSyncRun | null> {
  const result = await db.query<RunRow>(
    `SELECT * FROM channel_sync_runs WHERE reservation_id=$1${lock ? " FOR UPDATE" : ""}`,
    [reservationId],
  );
  return result.rows[0] ? mapRun(db, result.rows[0]) : null;
}

async function mapRun(db: PgQueryable, row: RunRow): Promise<ChannelSyncRun> {
  const memberResult = await db.query<Record<string, unknown>>(
    "SELECT * FROM channel_sync_run_rows WHERE run_id=$1 ORDER BY ordinal",
    [row.run_id],
  );
  const members = memberResult.rows.map(mapMember);
  const digest = createHash("sha256").update(JSON.stringify(members), "utf8").digest("hex");
  const complete = members.length === row.member_count && digest === row.member_digest;
  return {
    runId: row.run_id,
    revision: number(row.revision),
    sequence: number(row.sequence),
    connectionId: row.connection_id,
    providerKey: "tcgplayer",
    reservationId: row.reservation_id,
    claimant: { claimantKind: row.claimant_kind, claimantId: row.claimant_id },
    leaseExpiresAt: instant(row.lease_expires_at),
    manualClaimLeasePolicySnapshot: row.manual_claim_lease_policy_snapshot,
    state: row.state,
    basisSnapshotId: row.basis_snapshot_id,
    basisSnapshotGeneration: number(row.basis_snapshot_generation),
    verificationSnapshotId: row.verification_snapshot_id,
    verificationSnapshotGeneration:
      row.verification_snapshot_generation === null ? null : number(row.verification_snapshot_generation),
    uploadAttemptedAt: row.upload_attempted_at === null ? null : instant(row.upload_attempted_at),
    uploadFileName: row.upload_file_name,
    importSummary: row.import_summary,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
    membershipCompleteness: complete
      ? { kind: "complete", total: members.length }
      : { kind: "bounded-incomplete", reason: "member-count-or-digest-mismatch" },
    members,
  };
}

function mapMember(row: Record<string, unknown>): ChannelSyncRunMember {
  const common = {
    operationId: text(row.operation_id),
    attemptId: text(row.attempt_id),
    claimGeneration: number(row.claim_generation),
    reservationId: text(row.reservation_id),
    channelListingId: text(row.channel_listing_id),
    listingId: text(row.listing_id),
    desiredStateSequence: number(row.desired_state_sequence),
    listingRevision: number(row.listing_revision),
    payloadDigest: text(row.payload_digest),
    ordinal: number(row.ordinal),
  };
  const memberKind = text(row.member_kind);
  if (memberKind === "refused") {
    const refusalReason = text(row.refusal_reason);
    if (!tcgplayerLocalRefusalReasons.includes(refusalReason as never)) {
      throw new Error("Persisted refusal reason is invalid.");
    }
    const mappingDimension = nullableText(row.mapping_dimension);
    if (mappingDimension !== null && !["category", "condition", "attribute"].includes(mappingDimension)) {
      throw new Error("Persisted mapping dimension is invalid.");
    }
    return {
      ...common,
      memberKind,
      externalKey: nullableText(row.external_key),
      conditionText: nullableText(row.condition_text),
      basisSnapshotId: nullableText(row.basis_snapshot_id),
      basisSnapshotGeneration: nullableNumber(row.basis_snapshot_generation),
      basisTotalQuantity: nullableNumber(row.basis_total_quantity),
      basisPriceAmountMinor: nullableNumber(row.basis_price_amount_minor),
      targetQuantity: nullableNumber(row.target_quantity),
      targetPriceAmountMinor: nullableNumber(row.target_price_amount_minor),
      csvRow: null,
      refusalReason: refusalReason as TcgplayerLocalRefusalReason,
      mappingDimension: mappingDimension as "category" | "condition" | "attribute" | null,
      mappingSourceKey: nullableText(row.mapping_source_key),
    };
  }
  const details = {
    ...common,
    externalKey: text(row.external_key),
    conditionText: nullableText(row.condition_text),
    basisSnapshotId: text(row.basis_snapshot_id),
    basisSnapshotGeneration: number(row.basis_snapshot_generation),
    basisTotalQuantity: number(row.basis_total_quantity),
    basisPriceAmountMinor: number(row.basis_price_amount_minor),
    targetQuantity: number(row.target_quantity),
    targetPriceAmountMinor: number(row.target_price_amount_minor),
    refusalReason: null,
    mappingDimension: null,
    mappingSourceKey: null,
  };
  if (memberKind === "already-satisfied") {
    return { ...details, memberKind, csvRow: null, providerAction: "not-attempted-already-satisfied" };
  }
  return { ...details, memberKind: "composed", csvRow: record(row.csv_row_json) };
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Persisted integer is invalid.");
  return parsed;
}
function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Persisted text is invalid.");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function instant(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
function record(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Persisted record is invalid.");
  const result: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== "string") throw new Error("Persisted record member is invalid.");
    result[key] = member;
  }
  return result;
}
