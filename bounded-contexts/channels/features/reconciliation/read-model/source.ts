import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import type { ChannelPublicationDraft } from "../../publication-port/domain/contracts";
import { assertChannelPublicationDraft } from "../../publication-port/domain/validation";
import type { EnqueueOutboundOperation } from "../../outbound-sync/domain/contracts";

export type ReconciliationConnectionSource = Readonly<{
  connectionId: string;
  accountId: string;
  providerKey: string;
  environment: "sandbox" | "production";
  status: "pending-setup" | "active" | "paused" | "disconnected";
  bindings: readonly Readonly<{ storageLocationId: string; revision: number }>[];
}>;

export type ReconciliationExpectedListing = Readonly<{
  connectionId: string;
  accountId: string;
  channelListingId: string;
  listingId: string;
  externalListingId: string | null;
  externalOfferId: string | null;
  expectedRevision: number;
  expectedPrice: Readonly<{ amountMinor: number; currency: string }>;
  expectedQuantity: number;
  expectedMaterialFingerprint: string;
  lastAppliedRevision: number | null;
  desired: EnqueueOutboundOperation;
}>;

export async function readReconciliationConnection(
  db: PgQueryable,
  connectionId: string,
): Promise<ReconciliationConnectionSource | null> {
  const result = await db.query<{
    connection_id: string;
    account_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: ReconciliationConnectionSource["status"];
    bindings: unknown;
  }>(
    `SELECT connection_id,account_id,provider_key,environment,status,bindings
     FROM channel_connections WHERE connection_id=$1`,
    [connectionId],
  );
  const row = result.rows[0];
  return row
    ? {
        connectionId: row.connection_id,
        accountId: row.account_id,
        providerKey: row.provider_key,
        environment: row.environment,
        status: row.status,
        bindings: parseBindings(row.bindings),
      }
    : null;
}

export async function readExpectedReconciliationListings(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; limit: number }>,
): Promise<Readonly<{ items: readonly ReconciliationExpectedListing[]; bounded: boolean }>> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT link.connection_id,listing.account_id,link.channel_listing_id,link.listing_id,
            link.external_listing_id,link.external_offer_id,link.last_desired_listing_revision,
            link.last_desired_state_sequence,link.last_desired_state_hash,link.last_desired_intent,
            link.last_desired_payload,link.last_pushed_listing_revision,
            event.event_id,event.stream_id,event.stream_version,event.global_position,event.occurred_at,
            event.payload AS source_event_payload
     FROM channels_channel_listing_links AS link
     JOIN channel_connections AS connection ON connection.connection_id=link.connection_id
     JOIN channels_listing_publication_facts AS listing ON listing.listing_id=link.listing_id
     LEFT JOIN event_store_events AS event
       ON event.stream_id=('channels.channel-listing-' || link.channel_listing_id)
      AND event.stream_version=link.last_desired_state_sequence
      AND event.event_type='channels.channel-listing.desired-state-changed'
     WHERE link.connection_id=$1 AND listing.account_id=connection.account_id
       AND link.last_desired_state_sequence IS NOT NULL
       AND link.last_desired_listing_revision IS NOT NULL AND link.last_desired_state_hash IS NOT NULL
       AND link.last_desired_payload IS NOT NULL
     ORDER BY link.channel_listing_id LIMIT $2`,
    [input.connectionId, input.limit + 1],
  );
  const bounded = result.rows.length > input.limit;
  return { items: result.rows.slice(0, input.limit).map(mapExpectedListing), bounded };
}

export async function listDueReconciliationConnectionIds(
  db: PgQueryable,
  input: Readonly<{ now: string; limit: number }>,
): Promise<readonly string[]> {
  const result = await db.query<{ connection_id: string }>(
    `SELECT connection.connection_id
     FROM channel_connections AS connection
     LEFT JOIN channel_reconciliation_state AS run ON run.connection_id=connection.connection_id
     WHERE connection.status IN ('active','paused') AND (run.connection_id IS NULL OR run.next_due_at <= $1)
     ORDER BY COALESCE(run.next_due_at,'-infinity'::timestamptz),connection.connection_id LIMIT $2`,
    [input.now, input.limit],
  );
  return result.rows.map((row) => row.connection_id);
}

function mapExpectedListing(row: Record<string, unknown>): ReconciliationExpectedListing {
  const payload = asRecord(row.source_event_payload);
  const intent = requiredText(row.last_desired_intent);
  const listingRevision = positive(row.last_desired_listing_revision);
  const desiredStateSequence = positive(row.last_desired_state_sequence);
  const draft = intent === "delist" ? null : parseDraft(payload.draft);
  const delist = intent === "delist" ? asRecord(payload.delist) : null;
  if (!row.event_id || !row.stream_id || !row.global_position || !row.occurred_at) {
    throw new Error("Channel Reconciliation expected state has no authoritative desired-state event envelope.");
  }
  const channelListingId = requiredText(row.channel_listing_id);
  const listingId = requiredText(row.listing_id);
  if (
    payload.connectionId !== row.connection_id ||
    payload.channelListingId !== channelListingId ||
    payload.listingId !== listingId ||
    payload.listingRevision !== listingRevision ||
    payload.desiredStateSequence !== desiredStateSequence ||
    payload.desiredStateHash !== row.last_desired_state_hash ||
    payload.intent !== intent
  ) {
    throw new Error("Channel Reconciliation expected state provenance does not match its authoritative event.");
  }
  return {
    connectionId: requiredText(row.connection_id),
    accountId: requiredText(row.account_id),
    channelListingId,
    listingId,
    externalListingId: nullableText(row.external_listing_id),
    externalOfferId: nullableText(row.external_offer_id),
    expectedRevision: listingRevision,
    expectedPrice: draft?.price ?? parsePrice(delist?.lastPublishedPrice),
    expectedQuantity: draft?.quantity ?? 0,
    expectedMaterialFingerprint: requiredDigest(row.last_desired_state_hash),
    lastAppliedRevision: nullablePositive(row.last_pushed_listing_revision),
    desired: {
      connectionId: requiredText(row.connection_id),
      channelListingId,
      listingId,
      operationKind: intent === "delist" ? "delist" : intent === "publish" ? "publish" : "update",
      listingRevision,
      desiredStateSequence,
      desiredStateHash: requiredDigest(row.last_desired_state_hash),
      payload: intent === "delist" ? { kind: "delist", delist } : { kind: "draft", draft: draft! },
      envelope: {
        sourceEventId: requiredText(row.event_id),
        sourceStreamId: requiredText(row.stream_id),
        sourceStreamVersion: positive(row.stream_version),
        sourceGlobalPosition: parseGlobalPosition(String(row.global_position)),
        sourceOccurredAt: instant(row.occurred_at),
      },
    },
  };
}

function parseDraft(value: unknown): ChannelPublicationDraft {
  assertChannelPublicationDraft(value);
  return value;
}

function parsePrice(value: unknown): ReconciliationExpectedListing["expectedPrice"] {
  const price = asRecord(value);
  if (
    !Number.isSafeInteger(price.amountMinor) ||
    Number(price.amountMinor) < 0 ||
    typeof price.currency !== "string" ||
    !/^[A-Z]{3}$/.test(price.currency)
  ) {
    throw new Error("Invalid reconciliation source price.");
  }
  return { amountMinor: Number(price.amountMinor), currency: price.currency };
}

function parseBindings(value: unknown): ReconciliationConnectionSource["bindings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    return typeof record.storageLocationId === "string" && Number.isSafeInteger(record.revision)
      ? [{ storageLocationId: record.storageLocationId, revision: Number(record.revision) }]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid reconciliation source record.");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid reconciliation source text.");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : requiredText(value);
}
function positive(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid reconciliation source revision.");
  return number;
}
function nullablePositive(value: unknown): number | null {
  return value === null ? null : positive(value);
}
function requiredDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid reconciliation digest.");
  return value;
}
function instant(value: unknown): string {
  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid reconciliation instant.");
  return parsed.toISOString();
}
