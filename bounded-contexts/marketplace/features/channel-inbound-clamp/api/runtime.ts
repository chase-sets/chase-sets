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
  pausedStreamVersion: number | null;
}>;

export function createMarketplaceChannelInboundClampRuntime(
  db: PgTransactionalPool,
  listings: Pick<MarketplaceListingServices, "commandHandler" | "loadListingState" | "publishListing">,
): MarketplaceChannelInboundClampPort {
  return {
    engage: async (input, context) => engage(db, listings, input, context),
    recover: async (input, context) => recover(db, listings, input, context),
  };
}

async function engage(
  pool: PgTransactionalPool,
  listings: Pick<MarketplaceListingServices, "commandHandler" | "loadListingState">,
  input: MarketplaceChannelInboundClampInput,
  context: EventStoreContext,
): Promise<MarketplaceChannelInboundClampResult> {
  validateInput(input);
  const { candidates, requestedListingCount, affectedListingCount } = await readCandidates(pool, input);
  let clampedListingCount = 0;
  let recoveryListingCount = 0;

  for (const candidate of candidates) {
    if (candidate.clampState === "recovery") {
      recoveryListingCount += 1;
      continue;
    }
    if (candidate.clampState === "engaged") {
      const current = await readCurrentListing(pool, input.accountId, candidate.listingId);
      const state = await listings.loadListingState(candidate.listingId);
      if (
        current?.streamVersion === candidate.pausedStreamVersion &&
        state.accountId === input.accountId &&
        state.status === "paused" &&
        state.pauseReason === "channel-inbound-dark"
      ) {
        clampedListingCount += 1;
      } else {
        await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
        recoveryListingCount += 1;
      }
      continue;
    }

    if (candidate.clampState === "pending") {
      const current = await readCurrentListing(pool, input.accountId, candidate.listingId);
      const state = await listings.loadListingState(candidate.listingId);
      if (
        current?.streamVersion === candidate.streamVersion + 1 &&
        state.accountId === input.accountId &&
        state.status === "paused" &&
        state.pauseReason === "channel-inbound-dark"
      ) {
        const updated = await markPendingEngaged(pool, input, candidate, current.streamVersion);
        if (updated === 1) clampedListingCount += 1;
        else recoveryListingCount += 1;
      } else {
        await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
        recoveryListingCount += 1;
      }
      continue;
    }

    await insertPendingClamp(pool, input, candidate);
    try {
      const result = await listings.commandHandler({
        streamId: `marketplace.listing-${candidate.listingId}`,
        expectedVersion: candidate.streamVersion,
        command: { type: "PauseListing", reason: "channel-inbound-dark" },
        context,
      });
      if (
        result.newEvents.length !== 1 ||
        result.state.accountId !== input.accountId ||
        result.state.status !== "paused" ||
        result.state.pauseReason !== "channel-inbound-dark"
      ) {
        await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
        recoveryListingCount += 1;
        continue;
      }
      if ((await markPendingEngaged(pool, input, candidate, result.version)) !== 1) {
        await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
        recoveryListingCount += 1;
        continue;
      }
      clampedListingCount += 1;
    } catch {
      await markRecovery(pool, input, candidate.listingId, candidate.streamVersion);
      recoveryListingCount += 1;
    }
  }

  const current = await countCurrentCoverage(
    pool,
    input,
    candidates.map((candidate) => candidate.inventoryItemId),
  );
  if (current.unclampedActive > 0 || current.covered !== affectedListingCount) {
    recoveryListingCount += Math.max(current.unclampedActive, Math.abs(current.covered - affectedListingCount), 1);
  }
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
  candidate: Candidate,
  pausedVersion: number,
) {
  const updated = await pool.query(
    `UPDATE marketplace_channel_inbound_clamps
        SET state='engaged', paused_stream_version=$5, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2 AND run_id=$3 AND listing_id=$4
        AND state='pending' AND observed_stream_version=$6`,
    [input.accountId, input.connectionId, input.runId, candidate.listingId, pausedVersion, candidate.streamVersion],
  );
  return updated.rowCount ?? 0;
}

async function recover(
  pool: PgTransactionalPool,
  listings: Pick<MarketplaceListingServices, "loadListingState" | "publishListing">,
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
      `SELECT 1 FROM marketplace_channel_inbound_clamps
        WHERE listing_id=$1 AND state='engaged' AND NOT (connection_id=$2 AND run_id=$3)
        LIMIT 1`,
      [row.listing_id, input.connectionId, input.runId],
    );
    if (otherOwners.rows.length > 0) {
      const released = await releaseOwnership(pool, input, row.listing_id, pausedVersion);
      releasedListingCount += released;
      retainedListingCount += released;
      continue;
    }
    const current = await readCurrentListing(pool, input.accountId, row.listing_id);
    const state = await listings.loadListingState(row.listing_id);
    if (
      current?.streamVersion !== pausedVersion ||
      state.accountId !== input.accountId ||
      state.status !== "paused" ||
      state.pauseReason !== "channel-inbound-dark"
    ) {
      await markRecovery(pool, input, row.listing_id, pausedVersion);
      recoveryListingCount += 1;
      continue;
    }
    try {
      await listings.publishListing({ accountId: input.accountId, listingId: row.listing_id }, context);
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
        WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
          AND (listing.status='active' OR EXISTS (
            SELECT 1 FROM marketplace_channel_inbound_clamps AS clamp
             WHERE clamp.account_id=$1 AND clamp.connection_id=$3 AND clamp.run_id=$4
               AND clamp.listing_id=listing.listing_id AND clamp.state IN ('pending','engaged','recovery')
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
        paused_stream_version: string | number | null;
      }>(
        `SELECT listing.listing_id,listing.inventory_item_id,listing.status,stream.current_version,
                listing.updated_at,clamp.state AS clamp_state,clamp.paused_stream_version
           FROM marketplace_listing_pages AS listing
           JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
           LEFT JOIN marketplace_channel_inbound_clamps AS clamp
             ON clamp.account_id=$1 AND clamp.connection_id=$3 AND clamp.run_id=$4
            AND clamp.listing_id=listing.listing_id AND clamp.state IN ('pending','engaged','recovery')
          WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
            AND (listing.status='active' OR clamp.listing_id IS NOT NULL)
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
          pausedStreamVersion: row.paused_stream_version === null ? null : toPositiveInteger(row.paused_stream_version),
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

async function readCurrentListing(pool: PgQueryable, accountId: string, listingId: string) {
  const result = await pool.query<{ current_version: string | number }>(
    `SELECT stream.current_version
       FROM marketplace_listing_pages AS listing
       JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
      WHERE listing.account_id=$1 AND listing.listing_id=$2`,
    [accountId, listingId],
  );
  const row = result.rows[0];
  return row ? { streamVersion: toPositiveInteger(row.current_version) } : null;
}

async function countCurrentCoverage(
  pool: PgQueryable,
  input: MarketplaceChannelInboundClampInput,
  inventoryItemIds: readonly string[],
) {
  if (inventoryItemIds.length === 0) return { covered: 0, unclampedActive: 0 };
  const result = await pool.query<{ covered: string | number; unclamped_active: string | number }>(
    `SELECT count(*) AS covered,
            count(*) FILTER (WHERE listing.status='active' AND NOT (
              clamp.state='engaged' AND clamp.paused_stream_version=stream.current_version
            )) AS unclamped_active
       FROM marketplace_listing_pages AS listing
       JOIN event_store_streams AS stream ON stream.stream_id='marketplace.listing-' || listing.listing_id
       LEFT JOIN marketplace_channel_inbound_clamps AS clamp
         ON clamp.account_id=$1 AND clamp.connection_id=$3 AND clamp.run_id=$4
        AND clamp.listing_id=listing.listing_id AND clamp.state='engaged'
      WHERE listing.account_id=$1 AND listing.inventory_item_id = ANY($2::text[])
        AND (listing.status='active' OR clamp.listing_id IS NOT NULL)`,
    [input.accountId, [...new Set(inventoryItemIds)], input.connectionId, input.runId],
  );
  return {
    covered: toNonNegativeInteger(result.rows[0]?.covered),
    unclampedActive: toNonNegativeInteger(result.rows[0]?.unclamped_active),
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
