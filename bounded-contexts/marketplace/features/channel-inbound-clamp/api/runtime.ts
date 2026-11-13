import { createHash } from "node:crypto";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketplaceListingServices } from "../../listings/api/runtime";
import {
  MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS,
  MARKETPLACE_CHANNEL_INBOUND_CLAMP_PAGE_SIZE,
  MarketplaceChannelInboundClampError,
  type MarketplaceChannelInboundClampInput,
  type MarketplaceChannelInboundClampPort,
  type MarketplaceChannelInboundClampRecoveryResult,
  type MarketplaceChannelInboundClampResult,
} from "../domain/contracts";

type Candidate = Readonly<{
  listingId: string;
  inventoryItemId: string;
  status: string;
  streamVersion: number;
  updatedAt: string;
  clampState: "pending" | "engaged" | "recovery" | null;
  observedStreamVersion: number | null;
  pausedStreamVersion: number | null;
  sharedObservedStreamVersion: number | null;
  sharedPausedStreamVersion: number | null;
}>;

/** The clamp writes only through keyed Listing commands and decides only from complete Listing streams. */
export type MarketplaceChannelInboundClampListings = Pick<
  MarketplaceListingServices,
  "pauseListing" | "publishListing" | "readAuthoritativeListing"
>;

/**
 * One deterministic Listing attempt per run observation: the pause binds to the version the run observed and
 * the release binds to the version the run paused at, so resume replays the first receipt instead of writing.
 */
export function channelInboundClampAttemptKey(
  kind: "pause" | "release",
  input: Pick<MarketplaceChannelInboundClampInput, "accountId" | "connectionId" | "runId">,
  listingId: string,
  streamVersion: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "channel-inbound-clamp",
        kind,
        input.accountId,
        input.connectionId,
        input.runId,
        listingId,
        streamVersion,
      ]),
    )
    .digest("hex")
    .slice(0, 48);
  return `channel_clamp_${kind}_${digest}`;
}

export function createMarketplaceChannelInboundClampRuntime(
  db: PgTransactionalPool,
  listings: MarketplaceChannelInboundClampListings,
): MarketplaceChannelInboundClampPort {
  return {
    engage: async (input, context) => engage(db, listings, input, context),
    recover: async (input, context) => recover(db, listings, input, context),
  };
}

async function engage(
  pool: PgTransactionalPool,
  listings: MarketplaceChannelInboundClampListings,
  input: MarketplaceChannelInboundClampInput,
  context: EventStoreContext,
): Promise<MarketplaceChannelInboundClampResult> {
  validateInput(input);
  const { candidates, requestedListingCount, affectedListingCount } = await readCandidates(pool, input);
  let clampedListingCount = 0;
  const recoveryListingIds = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.clampState === "recovery") {
      recoveryListingIds.add(candidate.listingId);
      continue;
    }
    if (candidate.clampState === "engaged") {
      if (await heldByClamp(listings, input.accountId, candidate.listingId, candidate.pausedStreamVersion)) {
        clampedListingCount += 1;
      } else {
        await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
        recoveryListingIds.add(candidate.listingId);
      }
      continue;
    }

    if (candidate.clampState === "pending") {
      // Resume re-drives the same deterministic pause: a committed pause replays its receipt with zero appends,
      // an uncommitted one appends at the observed version, and any other writer's change conflicts.
      const observedVersion = candidate.observedStreamVersion ?? candidate.streamVersion;
      const pausedVersion = await pauseOnce(listings, input, candidate.listingId, observedVersion, context);
      if (
        pausedVersion !== null &&
        (await markPendingEngaged(pool, input, candidate.listingId, observedVersion, pausedVersion)) === 1
      ) {
        clampedListingCount += 1;
      } else {
        await markRecovery(pool, input, candidate.listingId, observedVersion);
        recoveryListingIds.add(candidate.listingId);
      }
      continue;
    }

    if (candidate.sharedObservedStreamVersion !== null && candidate.sharedPausedStreamVersion !== null) {
      if (
        (await heldByClamp(listings, input.accountId, candidate.listingId, candidate.sharedPausedStreamVersion)) &&
        (await insertSharedEngagedClamp(pool, input, candidate))
      ) {
        clampedListingCount += 1;
      } else {
        recoveryListingIds.add(candidate.listingId);
      }
      continue;
    }

    await insertPendingClamp(pool, input, candidate);
    const pausedVersion = await pauseOnce(listings, input, candidate.listingId, candidate.streamVersion, context);
    if (
      pausedVersion === null ||
      (await markPendingEngaged(pool, input, candidate.listingId, candidate.streamVersion, pausedVersion)) !== 1
    ) {
      await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
      recoveryListingIds.add(candidate.listingId);
      continue;
    }
    clampedListingCount += 1;
  }

  const current = await countCurrentCoverage(
    pool,
    input,
    candidates.map((candidate) => candidate.inventoryItemId),
  );
  const recoveryListingCount =
    current.unowned > 0 || current.covered !== affectedListingCount
      ? Math.max(recoveryListingIds.size, current.unowned, Math.abs(current.covered - affectedListingCount), 1)
      : recoveryListingIds.size;
  return {
    kind: recoveryListingCount === 0 ? "engaged" : "recovery",
    requestedListingCount,
    affectedListingCount,
    clampedListingCount,
    recoveryListingCount,
  };
}

async function markPendingEngaged(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  listingId: string,
  observedVersion: number,
  pausedVersion: number,
) {
  const updated = await pool.query(
    `UPDATE marketplace_channel_inbound_clamps
        SET state='engaged', paused_stream_version=$5, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2 AND run_id=$3 AND listing_id=$4
        AND state='pending' AND observed_stream_version=$6`,
    [input.accountId, input.connectionId, input.runId, listingId, pausedVersion, observedVersion],
  );
  return updated.rowCount ?? 0;
}

/**
 * Pauses at exactly the observed version under the run's deterministic attempt, then confirms from the complete
 * stream that the run's pause is the current fact. Any refusal, conflict or unreadable history is null.
 */
async function pauseOnce(
  listings: MarketplaceChannelInboundClampListings,
  input: MarketplaceChannelInboundClampInput,
  listingId: string,
  observedVersion: number,
  context: EventStoreContext,
): Promise<number | null> {
  try {
    const result = await listings.pauseListing(
      {
        accountId: input.accountId,
        listingId,
        reason: "channel-inbound-dark",
        expectedVersion: observedVersion,
        idempotencyKey: channelInboundClampAttemptKey("pause", input, listingId, observedVersion),
      },
      context,
    );
    if (result.version !== observedVersion + 1) return null;
    return (await heldByClamp(listings, input.accountId, listingId, result.version)) ? result.version : null;
  } catch {
    return null;
  }
}

/** True only when the complete owner stream ends at `version` with this account's dark-inbound pause. */
async function heldByClamp(
  listings: MarketplaceChannelInboundClampListings,
  accountId: string,
  listingId: string,
  version: number | null,
): Promise<boolean> {
  if (version === null) return false;
  try {
    const listing = await listings.readAuthoritativeListing({ accountId, listingId });
    return (
      listing.kind === "present" &&
      listing.version === version &&
      listing.state.accountId === accountId &&
      listing.state.status === "paused" &&
      listing.state.pauseReason === "channel-inbound-dark"
    );
  } catch {
    return false;
  }
}

async function recover(
  pool: PgTransactionalPool,
  listings: MarketplaceChannelInboundClampListings,
  input: MarketplaceChannelInboundClampInput,
  context: EventStoreContext,
): Promise<MarketplaceChannelInboundClampRecoveryResult> {
  validateInput(input);
  await assertRequestedListings(pool, input);
  const rows = await pool.query<{
    listing_id: string;
    paused_stream_version: string | number;
  }>(
    `SELECT listing_id,paused_stream_version
       FROM marketplace_channel_inbound_clamps
      WHERE account_id=$1 AND connection_id=$2 AND run_id=$3 AND state='engaged'
      ORDER BY listing_id`,
    [input.accountId, input.connectionId, input.runId],
  );
  let releasedListingCount = 0;
  let retainedListingCount = 0;
  let recoveryListingCount = 0;

  for (const row of rows.rows) {
    const pausedVersion = toPositiveInteger(row.paused_stream_version);
    const otherOwners = await pool.query(
      `SELECT 1
         FROM marketplace_channel_inbound_clamps AS owner
         JOIN event_store_streams AS stream
           ON stream.stream_id='marketplace.listing-' || owner.listing_id
        WHERE owner.account_id=$1 AND owner.listing_id=$2 AND owner.state='engaged'
          AND owner.paused_stream_version=stream.current_version
          AND NOT (owner.connection_id=$3 AND owner.run_id=$4)
        LIMIT 1`,
      [input.accountId, row.listing_id, input.connectionId, input.runId],
    );
    if (otherOwners.rows.length > 0) {
      if (!(await heldByClamp(listings, input.accountId, row.listing_id, pausedVersion))) {
        await markRecovery(pool, input, row.listing_id, pausedVersion);
        recoveryListingCount += 1;
        continue;
      }
      const released = await releaseOwnership(pool, input, row.listing_id, pausedVersion);
      releasedListingCount += released;
      retainedListingCount += released;
      continue;
    }
    try {
      // The release publishes at the paused version under the run's deterministic attempt: a resumed recovery
      // whose publication already committed replays that receipt, and any other writer's change conflicts.
      await listings.publishListing(
        {
          accountId: input.accountId,
          listingId: row.listing_id,
          expectedVersion: pausedVersion,
          idempotencyKey: channelInboundClampAttemptKey("release", input, row.listing_id, pausedVersion),
        },
        context,
      );
      releasedListingCount += await releaseOwnership(pool, input, row.listing_id, pausedVersion);
    } catch {
      await markRecovery(pool, input, row.listing_id, pausedVersion);
      recoveryListingCount += 1;
    }
  }

  return {
    kind: recoveryListingCount === 0 ? "released" : "recovery",
    examinedListingCount: rows.rows.length,
    releasedListingCount,
    retainedListingCount,
    recoveryListingCount,
  };
}

async function readCandidates(
  pool: PgTransactionalPool,
  input: MarketplaceChannelInboundClampInput,
): Promise<
  Readonly<{ candidates: readonly Candidate[]; requestedListingCount: number; affectedListingCount: number }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const inventoryItemIds = await assertRequestedListings(client, input);
    const count = await client.query<{ total: string | number }>(
      `SELECT count(*) AS total
         FROM marketplace_listing_pages AS listing
         JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
        WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
          AND (listing.status='active' OR EXISTS (
            SELECT 1 FROM marketplace_channel_inbound_clamps AS clamp
             WHERE clamp.account_id=$1 AND clamp.listing_id=listing.listing_id
               AND ((clamp.connection_id=$3 AND clamp.run_id=$4
                     AND clamp.state IN ('pending','engaged','recovery'))
                 OR (clamp.state='engaged' AND clamp.paused_stream_version=stream.current_version))
          ))`,
      [input.accountId, inventoryItemIds, input.connectionId, input.runId],
    );
    const affectedListingCount = toNonNegativeInteger(count.rows[0]?.total);
    if (affectedListingCount > MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS) {
      throw new MarketplaceChannelInboundClampError("listing-cap-exceeded");
    }
    const candidates: Candidate[] = [];
    let cursor = "";
    for (;;) {
      const page = await client.query<{
        listing_id: string;
        inventory_item_id: string;
        status: string;
        current_version: string | number;
        updated_at: string | Date;
        clamp_state: "pending" | "engaged" | "recovery" | null;
        observed_stream_version: string | number | null;
        paused_stream_version: string | number | null;
        shared_observed_stream_version: string | number | null;
        shared_paused_stream_version: string | number | null;
      }>(
        `SELECT listing.listing_id,listing.inventory_item_id,listing.status,stream.current_version,
                listing.updated_at,clamp.state AS clamp_state,clamp.observed_stream_version,
                clamp.paused_stream_version,
                shared.observed_stream_version AS shared_observed_stream_version,
                shared.paused_stream_version AS shared_paused_stream_version
           FROM marketplace_listing_pages AS listing
           JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
           LEFT JOIN marketplace_channel_inbound_clamps AS clamp
            ON clamp.account_id=$1 AND clamp.connection_id=$3 AND clamp.run_id=$4
            AND clamp.listing_id=listing.listing_id AND clamp.state IN ('pending','engaged','recovery')
           LEFT JOIN LATERAL (
             SELECT owner.observed_stream_version,owner.paused_stream_version
               FROM marketplace_channel_inbound_clamps AS owner
              WHERE owner.account_id=$1 AND owner.listing_id=listing.listing_id
                AND owner.state='engaged' AND owner.paused_stream_version=stream.current_version
              ORDER BY owner.connection_id,owner.run_id
              LIMIT 1
           ) AS shared ON true
          WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
            AND (listing.status='active' OR clamp.listing_id IS NOT NULL OR shared.paused_stream_version IS NOT NULL)
            AND listing.listing_id > $5
          ORDER BY listing.listing_id
          LIMIT ${MARKETPLACE_CHANNEL_INBOUND_CLAMP_PAGE_SIZE}`,
        [input.accountId, inventoryItemIds, input.connectionId, input.runId, cursor],
      );
      for (const row of page.rows) {
        candidates.push({
          listingId: row.listing_id,
          inventoryItemId: row.inventory_item_id,
          status: row.status,
          streamVersion: toPositiveInteger(row.current_version),
          updatedAt: instant(row.updated_at),
          clampState: row.clamp_state,
          observedStreamVersion:
            row.observed_stream_version === null ? null : toPositiveInteger(row.observed_stream_version),
          pausedStreamVersion: row.paused_stream_version === null ? null : toPositiveInteger(row.paused_stream_version),
          sharedObservedStreamVersion:
            row.shared_observed_stream_version === null ? null : toPositiveInteger(row.shared_observed_stream_version),
          sharedPausedStreamVersion:
            row.shared_paused_stream_version === null ? null : toPositiveInteger(row.shared_paused_stream_version),
        });
      }
      if (page.rows.length < MARKETPLACE_CHANNEL_INBOUND_CLAMP_PAGE_SIZE) break;
      cursor = page.rows.at(-1)?.listing_id ?? "";
      if (candidates.length >= MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS) {
        throw new MarketplaceChannelInboundClampError("listing-cap-exceeded");
      }
    }
    if (candidates.length !== affectedListingCount) {
      throw new MarketplaceChannelInboundClampError("listing-membership-incomplete");
    }
    await client.query("COMMIT");
    return { candidates, requestedListingCount: input.listingIds.length, affectedListingCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertSharedEngagedClamp(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  candidate: Candidate,
) {
  const result = await pool.query(
    `INSERT INTO marketplace_channel_inbound_clamps
     (account_id,connection_id,run_id,listing_id,inventory_item_id,state,observed_stream_version,
      paused_stream_version,observed_updated_at,created_at,updated_at)
     SELECT $1,$2,$3,$4,$5,'engaged',$6,$7,$8,now(),now()
      WHERE EXISTS (
        SELECT 1
          FROM marketplace_channel_inbound_clamps AS owner
          JOIN event_store_streams AS stream
            ON stream.stream_id='marketplace.listing-' || owner.listing_id
         WHERE owner.account_id=$1 AND owner.listing_id=$4 AND owner.state='engaged'
           AND owner.observed_stream_version=$6 AND owner.paused_stream_version=$7
           AND stream.current_version=$7
      )
     ON CONFLICT (connection_id,run_id,listing_id) DO NOTHING`,
    [
      input.accountId,
      input.connectionId,
      input.runId,
      candidate.listingId,
      candidate.inventoryItemId,
      candidate.sharedObservedStreamVersion,
      candidate.sharedPausedStreamVersion,
      candidate.updatedAt,
    ],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  const existing = await pool.query(
    `SELECT 1
       FROM marketplace_channel_inbound_clamps AS clamp
       JOIN event_store_streams AS stream
         ON stream.stream_id='marketplace.listing-' || clamp.listing_id
      WHERE clamp.account_id=$1 AND clamp.connection_id=$2 AND clamp.run_id=$3 AND clamp.listing_id=$4
        AND clamp.state='engaged' AND clamp.paused_stream_version=$5 AND stream.current_version=$5
      LIMIT 1`,
    [input.accountId, input.connectionId, input.runId, candidate.listingId, candidate.sharedPausedStreamVersion],
  );
  return existing.rows.length === 1;
}

async function assertRequestedListings(db: PgQueryable, input: MarketplaceChannelInboundClampInput) {
  const result = await db.query<{ listing_id: string; inventory_item_id: string }>(
    `WITH requested AS (
       SELECT value AS listing_id
         FROM jsonb_array_elements_text($1::jsonb)
     )
     SELECT requested.listing_id,listing.inventory_item_id
       FROM requested
       LEFT JOIN marketplace_listing_pages AS listing
         ON listing.listing_id=requested.listing_id AND listing.account_id=$2
      ORDER BY requested.listing_id`,
    [JSON.stringify(input.listingIds), input.accountId],
  );
  if (result.rows.length !== input.listingIds.length || result.rows.some((row) => !row.inventory_item_id)) {
    throw new MarketplaceChannelInboundClampError("listing-membership-incomplete");
  }
  return [...new Set(result.rows.map((row) => row.inventory_item_id))].sort();
}

async function insertPendingClamp(pool: PgQueryable, input: MarketplaceChannelInboundClampInput, candidate: Candidate) {
  await pool.query(
    `INSERT INTO marketplace_channel_inbound_clamps
     (account_id,connection_id,run_id,listing_id,inventory_item_id,state,observed_stream_version,
      paused_stream_version,observed_updated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,NULL,$7,now(),now())
     ON CONFLICT (connection_id,run_id,listing_id) DO NOTHING`,
    [
      input.accountId,
      input.connectionId,
      input.runId,
      candidate.listingId,
      candidate.inventoryItemId,
      candidate.streamVersion,
      candidate.updatedAt,
    ],
  );
}

async function markRecovery(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  listingId: string,
  expectedVersion: number,
) {
  await pool.query(
    `UPDATE marketplace_channel_inbound_clamps
        SET state='recovery', paused_stream_version=NULL, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2 AND run_id=$3 AND listing_id=$4
        AND state<>'released' AND (observed_stream_version=$5 OR paused_stream_version=$5)`,
    [input.accountId, input.connectionId, input.runId, listingId, expectedVersion],
  );
}

async function releaseOwnership(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  listingId: string,
  pausedVersion: number,
) {
  const result = await pool.query(
    `UPDATE marketplace_channel_inbound_clamps
        SET state='released', paused_stream_version=NULL, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2 AND run_id=$3 AND listing_id=$4
        AND state='engaged' AND paused_stream_version=$5`,
    [input.accountId, input.connectionId, input.runId, listingId, pausedVersion],
  );
  return result.rowCount ?? 0;
}

async function countCurrentCoverage(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  inventoryItemIds: readonly string[],
) {
  if (inventoryItemIds.length === 0) return { covered: 0, unowned: 0 };
  const result = await pool.query<{ covered: string | number; unowned: string | number }>(
    `SELECT count(*) AS covered,
            count(*) FILTER (WHERE NOT (
              clamp.state='engaged' AND clamp.paused_stream_version=stream.current_version
            )) AS unowned
       FROM marketplace_listing_pages AS listing
       JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
       LEFT JOIN marketplace_channel_inbound_clamps AS clamp
         ON clamp.account_id=$1 AND clamp.connection_id=$3 AND clamp.run_id=$4
        AND clamp.listing_id=listing.listing_id AND clamp.state='engaged'
      WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
        AND (listing.status='active' OR clamp.listing_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM marketplace_channel_inbound_clamps AS owner
           WHERE owner.account_id=$1 AND owner.listing_id=listing.listing_id
             AND owner.state='engaged' AND owner.paused_stream_version=stream.current_version
        ))`,
    [input.accountId, [...new Set(inventoryItemIds)], input.connectionId, input.runId],
  );
  return {
    covered: toNonNegativeInteger(result.rows[0]?.covered),
    unowned: toNonNegativeInteger(result.rows[0]?.unowned),
  };
}

function validateInput(value: MarketplaceChannelInboundClampInput) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceChannelInboundClampError("invalid-input");
  }
  const keys = Object.keys(value);
  const expected = ["accountId", "connectionId", "runId", "listingIds"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new MarketplaceChannelInboundClampError("invalid-input");
  }
  if (![value.accountId, value.connectionId, value.runId].every(isBoundedId)) {
    throw new MarketplaceChannelInboundClampError("invalid-input");
  }
  if (
    !Array.isArray(value.listingIds) ||
    value.listingIds.length < 1 ||
    value.listingIds.length > MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS ||
    !value.listingIds.every(isBoundedId) ||
    new Set(value.listingIds).size !== value.listingIds.length
  ) {
    throw new MarketplaceChannelInboundClampError("invalid-input");
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function toPositiveInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MarketplaceChannelInboundClampError("listing-membership-unsafe");
  }
  return parsed;
}

function toNonNegativeInteger(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MarketplaceChannelInboundClampError("listing-membership-unsafe");
  }
  return parsed;
}

function instant(value: string | Date): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (Number.isNaN(Date.parse(text))) throw new MarketplaceChannelInboundClampError("listing-membership-unsafe");
  return text;
}
