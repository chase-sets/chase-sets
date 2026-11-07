import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Post-ACK retention for the `inventory-draft-listing/v1` handoff.
 *
 * Outbox rows and their Marketplace receipts are never deleted (see the
 * `inventory_import_draft_listing_outbox` retention exemption). The only
 * cleanup this module performs is deleting completed or failed commit jobs,
 * whose events and work units cascade with them, and it does so only after
 * every outbox row of the job's batch carries a durable acknowledgement.
 */

export const DRAFT_LISTING_HANDOFF_PAGE_LIMIT = 500;
export const DRAFT_LISTING_HANDOFF_MAX_PAGES = 50;
const MAX_PAGE_LIMIT = 500;
const MAX_PAGES = 100;
const MAX_FINDINGS = 100;

/** The staged-input resume window, scanned before the commit-job retention cutoff. */
export const DRAFT_LISTING_HANDOFF_RESUME_GRACE_MS = 24 * 60 * 60 * 1_000;

/**
 * A durable acknowledgement is an accepted row whose stored receipt names this
 * exact message and batch. A missing key or a receipt for another identity is
 * not an acknowledgement; COALESCE keeps that NULL from reading as "not unacknowledged".
 */
const DURABLY_ACKNOWLEDGED_SQL = `COALESCE(
  outbox.state = 'accepted'
  AND outbox.accepted_at IS NOT NULL
  AND outbox.receipt->>'messageId' = outbox.message_id
  AND outbox.receipt->>'importBatchId' = outbox.import_batch_id,
  false)`;

const UTC_MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export const draftListingHandoffClasses = [
  "accepted",
  "pending",
  "sending",
  "reclaimable",
  "failed",
  "uncommitted",
  "legacy",
  "orphan",
  "ambiguous",
] as const;
export type DraftListingHandoffClass = (typeof draftListingHandoffClasses)[number];

/** Classes that mean a committed handoff is missing or contradictory; they hold commit-job cleanup. */
const RETENTION_HOLDING_CLASSES: ReadonlySet<DraftListingHandoffClass> = new Set([
  "orphan",
  "ambiguous",
  "uncommitted",
]);

export type DraftListingHandoffRow = Readonly<{
  row_id: string;
  batch_id: string;
  row_status: string;
  has_listing: boolean;
  after_lineage: boolean | null;
  outbox_state: string | null;
  acknowledged: boolean | null;
  claim_expired: boolean | null;
  cursor_created_at: string;
}>;

export type DraftListingHandoffFinding = Readonly<{
  batchId: string;
  rowId: string;
  handoff: DraftListingHandoffClass;
}>;

export type DraftListingHandoffScan = Readonly<{
  since: string;
  until: string;
  lineageStartedAt: string | null;
  complete: boolean;
  pages: number;
  scannedRows: number;
  counts: Readonly<Record<DraftListingHandoffClass, number>>;
  findings: readonly DraftListingHandoffFinding[];
  findingsTruncated: boolean;
}>;

const ISO_INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Accepts a valid `Date` or an ISO-8601 instant with an explicit offset.
 * Date-only and offset-less strings would be read in the database session
 * time zone, so they are refused rather than guessed.
 */
export function parseRetentionInstant(value: Date | string): Date {
  const parsed =
    value instanceof Date ? value : ISO_INSTANT_WITH_OFFSET.test(value) ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("Retention instants must be a valid Date or an ISO-8601 timestamp with an offset.");
  }
  return parsed;
}

function boundedPositiveInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}

/**
 * Classifies one scanned import row against its qualified outbox row.
 * Returns `null` for rows that never needed a draft handoff.
 */
export function classifyDraftListingHandoff(row: DraftListingHandoffRow): DraftListingHandoffClass | null {
  if (row.outbox_state === null) {
    if (row.row_status !== "committed" || !row.has_listing) return null;
    // Unknown lineage (a committed listing row without committed_at) is never guessed to be legacy.
    if (row.after_lineage === null) return "ambiguous";
    return row.after_lineage ? "orphan" : "legacy";
  }
  if (row.row_status !== "committed") return "uncommitted";
  if (!row.has_listing) return "ambiguous";
  switch (row.outbox_state) {
    case "accepted":
      return row.acknowledged === true ? "accepted" : "ambiguous";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "sending":
      // Mirrors the drain's reclaim predicate: a sending row without a lease end is never reclaimed.
      if (row.claim_expired === null) return "ambiguous";
      return row.claim_expired ? "reclaimable" : "sending";
    default:
      return "ambiguous";
  }
}

/**
 * A scanned orphan, ambiguous or uncommitted handoff holds every commit-job
 * deletion. An incomplete scan never claims "no orphan" (`complete: false`),
 * but it does not hold by itself: each deletion is still gated by its own
 * unpaged per-batch predicate in `pruneAcknowledgedImportCommitJobs`, so a
 * window larger than the page budget cannot stop retention for good.
 */
export function draftListingHandoffScanHoldsRetention(scan: DraftListingHandoffScan): boolean {
  return draftListingHandoffClasses.some(
    (handoff) => RETENTION_HOLDING_CLASSES.has(handoff) && scan.counts[handoff] > 0,
  );
}

/**
 * Bounded resume-window scan over import rows created in `[since, until]`.
 *
 * Every committed row with a listing and every row with an outbox row is
 * classified. Pages walk `inventory_import_batch_rows_handoff_scan_idx`
 * `(created_at, row_id)` with one look-ahead row, so a decisive row just
 * beyond a page is always read by the next page. When `maxPages` ends the
 * scan before the window is exhausted the result is `complete: false`, never
 * a "no orphan" report.
 *
 * Lineage is causal: the earliest outbox write (one endpoint read of
 * `inventory_import_draft_listing_outbox_lineage_idx`) proves the durable
 * writer was live, so a committed listing row without an outbox row is an
 * `orphan` when it was committed at or after that write, and `legacy` before it.
 */
export async function scanInventoryDraftListingHandoffs(
  db: PgQueryable,
  input: Readonly<{ since: Date | string; pageLimit?: number; maxPages?: number }>,
): Promise<DraftListingHandoffScan> {
  const since = parseRetentionInstant(input.since).toISOString();
  const pageLimit = boundedPositiveInteger(
    input.pageLimit ?? DRAFT_LISTING_HANDOFF_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    "pageLimit",
  );
  const maxPages = boundedPositiveInteger(input.maxPages ?? DRAFT_LISTING_HANDOFF_MAX_PAGES, MAX_PAGES, "maxPages");

  const head = await db.query<{ scan_until: string; lineage_started_at: string | null }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', ${UTC_MICROS}) AS scan_until,
            (SELECT to_char(outbox.created_at AT TIME ZONE 'UTC', ${UTC_MICROS})
             FROM inventory_import_draft_listing_outbox AS outbox
             ORDER BY outbox.created_at ASC, outbox.message_id ASC
             LIMIT 1) AS lineage_started_at`,
  );
  const window = head.rows[0];
  if (!window?.scan_until) throw new Error("Draft listing handoff scan could not read its window.");

  const counts = Object.fromEntries(draftListingHandoffClasses.map((handoff) => [handoff, 0])) as Record<
    DraftListingHandoffClass,
    number
  >;
  const findings: DraftListingHandoffFinding[] = [];
  let findingsTruncated = false;
  // Seeded at the window start so every page is one indexable row comparison; row IDs are never empty.
  let cursor: Readonly<{ createdAt: string; rowId: string }> = { createdAt: since, rowId: "" };
  let pages = 0;
  let scannedRows = 0;
  let complete = false;

  while (pages < maxPages) {
    const page: { rows: DraftListingHandoffRow[] } = await db.query<DraftListingHandoffRow>(
      `SELECT import_row.row_id,
              import_row.batch_id,
              import_row.status AS row_status,
              import_row.committed_listing_id IS NOT NULL AS has_listing,
              CASE WHEN $3::timestamptz IS NULL THEN false
                   ELSE import_row.committed_at >= $3::timestamptz END AS after_lineage,
              outbox.state AS outbox_state,
              ${DURABLY_ACKNOWLEDGED_SQL} AS acknowledged,
              outbox.claimed_until <= now() AS claim_expired,
              to_char(import_row.created_at AT TIME ZONE 'UTC', ${UTC_MICROS}) AS cursor_created_at
       FROM inventory_import_batch_rows AS import_row
       LEFT JOIN inventory_import_draft_listing_outbox AS outbox
         ON outbox.message_id = import_row.row_id
        AND outbox.import_batch_id = import_row.batch_id
       WHERE import_row.created_at >= $1::timestamptz
         AND import_row.created_at <= $2::timestamptz
         AND (import_row.created_at, import_row.row_id) > ($4::timestamptz, $5::text)
       ORDER BY import_row.created_at ASC, import_row.row_id ASC
       LIMIT $6`,
      [since, window.scan_until, window.lineage_started_at, cursor.createdAt, cursor.rowId, pageLimit + 1],
    );
    pages += 1;
    const rows = page.rows.slice(0, pageLimit);
    for (const row of rows) {
      scannedRows += 1;
      const handoff = classifyDraftListingHandoff(row);
      if (!handoff) continue;
      counts[handoff] += 1;
      if (RETENTION_HOLDING_CLASSES.has(handoff)) {
        if (findings.length < MAX_FINDINGS) findings.push({ batchId: row.batch_id, rowId: row.row_id, handoff });
        else findingsTruncated = true;
      }
    }
    if (page.rows.length <= pageLimit) {
      complete = true;
      break;
    }
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.cursor_created_at, rowId: last.row_id };
  }

  return {
    since,
    until: window.scan_until,
    lineageStartedAt: window.lineage_started_at,
    complete,
    pages,
    scannedRows,
    counts,
    findings,
    findingsTruncated,
  };
}

/**
 * Deletes completed or failed commit jobs older than `completedBefore` only
 * when the job's own batch proves every handoff settled, independent of the
 * resume-window scan:
 *
 * - every outbox row of the batch is durably acknowledged and belongs to a
 *   committed listing row of the same batch (pending, sending, failed,
 *   receipt-less, mis-identified and uncommitted handoffs retain the job); and
 * - no committed listing row of the batch committed at or after the outbox
 *   lineage start, or without a commit time, lacks its batch-qualified outbox
 *   row (an orphan retains the job).
 *
 * Retained jobs keep their events and work units. The batch predicate ignores
 * the account, so a mis-scoped outbox row still retains the job.
 */
export async function pruneAcknowledgedImportCommitJobs(
  db: PgQueryable,
  input: Readonly<{
    jobKind: string;
    completedBefore: Date | string;
    lineageStartedAt: Date | string | null;
    limit?: number;
  }>,
): Promise<number> {
  const lineageStartedAt =
    input.lineageStartedAt === null ? null : parseRetentionInstant(input.lineageStartedAt).toISOString();
  const result = await db.query<{ job_id: string }>(
    `WITH expired AS (
       SELECT job.job_id
       FROM inventory_import_batch_jobs AS job
       WHERE job.job_kind = $3
         AND job.status IN ('completed', 'failed')
         AND job.completed_at < $1::timestamptz
         AND job.payload->>'batchId' IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM inventory_import_draft_listing_outbox AS outbox
           LEFT JOIN inventory_import_batch_rows AS import_row
             ON import_row.row_id = outbox.message_id
            AND import_row.batch_id = outbox.import_batch_id
           WHERE outbox.import_batch_id = job.payload->>'batchId'
             AND NOT COALESCE(
               ${DURABLY_ACKNOWLEDGED_SQL}
               AND import_row.status = 'committed'
               AND import_row.committed_listing_id IS NOT NULL,
               false)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM inventory_import_batch_rows AS import_row
           LEFT JOIN inventory_import_draft_listing_outbox AS outbox
             ON outbox.message_id = import_row.row_id
            AND outbox.import_batch_id = import_row.batch_id
           WHERE import_row.batch_id = job.payload->>'batchId'
             AND import_row.status = 'committed'
             AND import_row.committed_listing_id IS NOT NULL
             AND outbox.message_id IS NULL
             AND $4::timestamptz IS NOT NULL
             AND (import_row.committed_at IS NULL OR import_row.committed_at >= $4::timestamptz)
         )
       ORDER BY job.completed_at ASC, job.job_id ASC
       LIMIT $2
       FOR UPDATE OF job SKIP LOCKED
     )
     DELETE FROM inventory_import_batch_jobs AS job
     USING expired
     WHERE job.job_id = expired.job_id
     RETURNING job.job_id`,
    [
      parseRetentionInstant(input.completedBefore).toISOString(),
      Math.max(1, Math.min(input.limit ?? 500, 5_000)),
      input.jobKind,
      lineageStartedAt,
    ],
  );
  return Number(result.rowCount ?? result.rows.length);
}
