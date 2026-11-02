import { createHash } from "node:crypto";
import {
  canonicalDraftValue,
  canonicalInventoryDraftListingIntent,
  compareInventoryDraftSelectedOptions,
  inventoryDraftListingMessageSchema,
  inventoryDraftListingReceiptSchema,
  type InventoryDraftListingUnavailableDiagnostic,
  listingIdForInventoryDraftRow,
  type InventoryDraftListingErrorCode,
  type InventoryDraftListingMessage,
  type InventoryDraftListingReceipt,
} from "@chase-sets/inventory-draft-listing";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  getEventCommitMetadata,
  recordCommittedEvents,
  runWithEventCommitMetadata,
} from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { ListingId } from "@chase-sets/primitives/typed-ids";
import { normalizeAddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { MarketplaceListingServices } from "./runtime";
import { normalizePurchaseLimits } from "../domain/domain";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { inventoryListingCapacityStreamId } from "../domain/inventory-listing-capacity";
import { INVENTORY_DRAFT_RECEIPT_MIGRATION_ID } from "../read-model/inventory-draft-receipt-schema";
import {
  parseInventoryDraftReceiptRow,
  type InventoryDraftReceiptRow as ReceiptRow,
} from "../read-model/inventory-draft-receipt";

export class InventoryDraftListingConflict extends Error {
  readonly code: InventoryDraftListingErrorCode = "inventory-draft-conflict";
  constructor() {
    super("Inventory draft message cannot be accepted.");
    this.name = "InventoryDraftListingConflict";
  }
}

export class InventoryDraftListingUnavailable extends Error {
  readonly code: InventoryDraftListingErrorCode = "inventory-draft-unavailable";
  readonly diagnostic: InventoryDraftListingUnavailableDiagnostic;
  constructor(diagnostic: InventoryDraftListingUnavailableDiagnostic = "unexpected-failure") {
    super("Inventory draft acceptance is unavailable. Read the same message receipt before retrying.");
    this.name = "InventoryDraftListingUnavailable";
    this.diagnostic = diagnostic;
  }
}

export type InventoryDraftListingConsumer = Readonly<{
  accept(input: unknown, context: EventStoreContext): Promise<InventoryDraftListingReceipt>;
  readReceipt(messageId: string, context: EventStoreContext): Promise<InventoryDraftListingReceipt | null>;
}>;

function readStoredReceipt(row: ReceiptRow): InventoryDraftListingReceipt {
  const receipt = parseInventoryDraftReceiptRow(row);
  if (!receipt) throw new InventoryDraftListingConflict();
  return receipt;
}

async function assertReceiptSchemaReady(db: PgQueryable): Promise<void> {
  const result = await db.query<{ ready: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM bounded_context_schema_migrations WHERE migration_id = $1)
       AND EXISTS (SELECT 1 FROM pg_trigger AS receipt_trigger
         JOIN pg_class AS receipt ON receipt.oid = receipt_trigger.tgrelid
         WHERE receipt_trigger.tgrelid = 'marketplace_inventory_draft_receipts'::regclass
           AND receipt_trigger.tgname = 'marketplace_inventory_draft_receipts_immutable'
           AND receipt_trigger.tgenabled = 'O' AND NOT receipt_trigger.tgisinternal AND receipt.relpersistence = 'p') AS ready`,
    [INVENTORY_DRAFT_RECEIPT_MIGRATION_ID],
  );
  if (result.rows.length !== 1 || !result.rows[0]?.ready)
    throw new InventoryDraftListingUnavailable("receipt-ledger-not-ready");
}

async function loadReceipt(db: PgQueryable, messageId: string): Promise<ReceiptRow | undefined> {
  const rows = (
    await db.query<ReceiptRow>(
      `SELECT message_id, tenant_id, account_id, performed_by_user_id, listing_id, intent_hash, receipt, accepted_at
     FROM marketplace_inventory_draft_receipts WHERE message_id = $1`,
      [messageId],
    )
  ).rows;
  if (rows.length > 1) throw new InventoryDraftListingConflict();
  return rows[0];
}

function ownsReceipt(row: ReceiptRow, context: EventStoreContext): boolean {
  return (
    row.tenant_id === context.tenantId &&
    row.account_id === context.audit.forAccountId &&
    row.performed_by_user_id === context.audit.performedByUserId
  );
}

function normalizedLegacyOptions(value: unknown): readonly { dimensionId: string; optionId: string }[] {
  if (!Array.isArray(value)) throw new InventoryDraftListingConflict();
  const options: { dimensionId: string; optionId: string }[] = [];
  const dimensions = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== "dimensionId" && key !== "optionId")
    )
      throw new InventoryDraftListingConflict();
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
    const dimensionId = record.dimensionId;
    const optionId = record.optionId;
    if (
      typeof dimensionId !== "string" ||
      typeof optionId !== "string" ||
      dimensionId.trim() === "" ||
      optionId.trim() === ""
    )
      throw new InventoryDraftListingConflict();
    if (dimensions.has(dimensionId)) throw new InventoryDraftListingConflict();
    dimensions.add(dimensionId);
    options.push({ dimensionId, optionId });
  }
  return options.sort(compareInventoryDraftSelectedOptions);
}

async function inspectDraft(
  db: PgQueryable,
  eventStore: EventStore,
  message: InventoryDraftListingMessage,
): Promise<{ version: number; feeQuoteFingerprint: string | null }> {
  const listingId = listingIdForInventoryDraftRow(message.snapshot.importRowId);
  const streamId = `marketplace.listing-${listingId}`;
  const versions = (
    await db.query<{ current_version: number }>(
      `SELECT current_version FROM event_store_streams WHERE stream_id = $1 FOR UPDATE`,
      [streamId],
    )
  ).rows;
  if (Number(versions[0]?.current_version ?? 0) > 1) throw new InventoryDraftListingConflict();
  const events = await readCompleteStream(eventStore, { streamId, maxEvents: 1 });
  if (versions.length > 1 || events.length !== Number(versions[0]?.current_version ?? 0)) {
    throw new InventoryDraftListingConflict();
  }
  if (events.length === 0) return { version: 0, feeQuoteFingerprint: null };
  // Only an untouched, owner-attributed legacy draft can acquire its first receipt.
  const event = events[0]!;
  if (
    events.length !== 1 ||
    event.eventType !== "marketplace.listing.created" ||
    event.tenantId !== message.authority.tenantId ||
    event.forAccountId !== message.authority.accountId ||
    event.performedByUserId !== message.authority.performedByUserId
  )
    throw new InventoryDraftListingConflict();
  const snapshot = message.snapshot;
  const expected = {
    listingId,
    accountId: message.authority.accountId,
    inventoryItemId: snapshot.inventoryItemId,
    catalogItemId: snapshot.catalogItemId,
    productId: snapshot.productId,
    selectedOptions: snapshot.selectedOptions,
    gradedCard: null,
    storageLocationName: snapshot.storageLocationName,
    shipFromCode: snapshot.shipFromCode,
    shipFromAddress: normalizeAddressSnapshot(snapshot.shipFromAddress, "Ship-from address"),
    priceAmount: snapshot.priceAmount,
    priceCurrencyCode: snapshot.priceCurrencyCode,
    quantityCap: snapshot.quantityCap,
    purchaseLimits: normalizePurchaseLimits(undefined, snapshot.quantityCap),
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "selectedOptions" ? normalizedLegacyOptions(event.payload[key]) : event.payload[key];
    if (canonicalDraftValue(actual) !== canonicalDraftValue(value)) {
      throw new InventoryDraftListingConflict();
    }
  }
  const fingerprint = event.payload.feeQuoteFingerprint;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) throw new InventoryDraftListingConflict();
  return { version: event.streamVersion, feeQuoteFingerprint: fingerprint };
}

function parseMessage(input: unknown): InventoryDraftListingMessage {
  try {
    const message = inventoryDraftListingMessageSchema.parse(input);
    normalizeAddressSnapshot(message.snapshot.shipFromAddress, "Ship-from address");
    return message;
  } catch {
    throw new InventoryDraftListingConflict();
  }
}

export function createInventoryDraftListingConsumer(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: PostgresEventStore;
    createListings(
      db: PgQueryable,
      eventStore: EventStore,
    ): Pick<MarketplaceListingServices, "createBatchDraftListingFromInventorySnapshot">;
  }>,
): InventoryDraftListingConsumer {
  return {
    readReceipt: async (messageId, context) => {
      try {
        await assertReceiptSchemaReady(deps.pool);
        const row = await loadReceipt(deps.pool, messageId);
        return row && ownsReceipt(row, context) ? readStoredReceipt(row) : null;
      } catch (error) {
        if (error instanceof InventoryDraftListingConflict) throw error;
        if (error instanceof InventoryDraftListingUnavailable) throw error;
        throw new InventoryDraftListingUnavailable();
      }
    },
    accept: async (input, context) => {
      const message = parseMessage(input);
      if (
        message.authority.tenantId !== context.tenantId ||
        message.authority.accountId !== context.audit.forAccountId ||
        message.authority.performedByUserId !== context.audit.performedByUserId
      )
        throw new InventoryDraftListingConflict();
      const intentHash = createHash("sha256").update(canonicalInventoryDraftListingIntent(message)).digest("hex");
      const listingId = listingIdForInventoryDraftRow(message.snapshot.importRowId);
      try {
        const accepted = await runWithEventCommitMetadata(async () => {
          const receipt = await withPgTransaction(deps.pool, async (client) => {
            await assertReceiptSchemaReady(client);
            await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
              `inventory-draft:${listingId}`,
            ]);
            const existing = await loadReceipt(client, message.messageId);
            if (existing) {
              if (!ownsReceipt(existing, context) || existing.intent_hash !== intentHash)
                throw new InventoryDraftListingConflict();
              const receipt = readStoredReceipt(existing);
              if (
                receipt.importBatchId !== message.snapshot.importBatchId ||
                receipt.importRowId !== message.snapshot.importRowId
              ) {
                throw new InventoryDraftListingConflict();
              }
              return receipt;
            }
            const eventStore: EventStore = {
              ...deps.eventStore,
              readStream: (input) => deps.eventStore.readStreamInTransaction(client, input),
              appendToStream: (input) => deps.eventStore.appendToStreamInTransaction(client, input),
              appendToStreams: (inputs) => deps.eventStore.appendToStreamsInTransaction(client, inputs),
            };
            await deps.eventStore.appendToStreamsInTransaction(client, [
              {
                streamId: inventoryListingCapacityStreamId(message.snapshot.inventoryItemId),
                expectedVersion: "any",
                events: [],
                context,
              },
              { streamId: `marketplace.listing-${listingId}`, expectedVersion: "any", events: [], context },
            ]);
            const legacy = await inspectDraft(client, eventStore, message);
            const result =
              legacy.version > 0
                ? {
                    listingId,
                    version: legacy.version,
                    feeQuoteFingerprint: legacy.feeQuoteFingerprint,
                  }
                : await deps.createListings(client, eventStore).createBatchDraftListingFromInventorySnapshot(
                    {
                      accountId: message.authority.accountId,
                      importBatchId: message.snapshot.importBatchId,
                      importRowId: message.snapshot.importRowId,
                      inventoryItemId: message.snapshot.inventoryItemId,
                      listingIdOverride: listingId as ListingId,
                      catalogItemId: message.snapshot.catalogItemId,
                      productId: message.snapshot.productId,
                      selectedOptions: message.snapshot.selectedOptions,
                      storageLocationId: message.snapshot.storageLocationId,
                      storageLocationName: message.snapshot.storageLocationName,
                      shipFromCode: message.snapshot.shipFromCode,
                      shipFromAddress: message.snapshot.shipFromAddress,
                      totalQuantity: message.snapshot.totalQuantity,
                      acquisitionCostAmount: message.snapshot.acquisitionCostAmount,
                      // The frozen draft message is amount-only, so its cost denomination stays unknown.
                      acquisitionCostCurrencyCode: undefined,
                      priceAmount: message.snapshot.priceAmount,
                      priceCurrencyCode: message.snapshot.priceCurrencyCode,
                      quantityCap: message.snapshot.quantityCap,
                    },
                    context,
                  );
            const acceptedDraft = await inspectDraft(client, eventStore, message);
            const { version } = acceptedDraft;
            if (
              result.listingId !== listingId ||
              result.version !== version ||
              version !== 1 ||
              result.feeQuoteFingerprint !== acceptedDraft.feeQuoteFingerprint
            )
              throw new InventoryDraftListingConflict();
            const receipt = inventoryDraftListingReceiptSchema.parse({
              schemaVersion: "inventory-draft-listing-receipt/v1",
              messageVersion: message.schemaVersion,
              messageId: message.messageId,
              ...message.authority,
              importBatchId: message.snapshot.importBatchId,
              importRowId: message.snapshot.importRowId,
              intentHash,
              listingId,
              listingVersion: version,
              feeQuoteFingerprint: result.feeQuoteFingerprint,
              acceptedAt: new Date().toISOString(),
              source: legacy.version === 0 ? "message" : "legacy-draft",
            });
            await client.query(
              `INSERT INTO marketplace_inventory_draft_receipts
           (message_id, tenant_id, account_id, performed_by_user_id, listing_id, intent_hash, receipt, accepted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
              [
                receipt.messageId,
                receipt.tenantId,
                receipt.accountId,
                receipt.performedByUserId,
                receipt.listingId,
                receipt.intentHash,
                JSON.stringify(receipt),
                receipt.acceptedAt,
              ],
            );
            return receipt;
          });
          return { receipt, events: getEventCommitMetadata().committedEvents };
        });
        recordCommittedEvents(accepted.events);
        return accepted.receipt;
      } catch (error) {
        if (error instanceof InventoryDraftListingConflict) throw error;
        if (error instanceof InventoryDraftListingUnavailable) throw error;
        if (error instanceof MarketplaceListingDomainError && error.code === "command-rejected")
          throw new InventoryDraftListingUnavailable("listing-rejected");
        throw new InventoryDraftListingUnavailable("unexpected-failure");
      }
    },
  };
}

export function bindInventoryDraftListingConsumer(
  resolve: () => InventoryDraftListingConsumer | undefined,
): InventoryDraftListingConsumer {
  function consumer() {
    const value = resolve();
    if (!value) return undefined;
    return value;
  }
  return {
    accept: (input, context) => {
      const value = consumer();
      return value
        ? value.accept(input, context)
        : Promise.reject(new InventoryDraftListingUnavailable("consumer-unbound"));
    },
    readReceipt: (messageId, context) => {
      const value = consumer();
      return value
        ? value.readReceipt(messageId, context)
        : Promise.reject(new InventoryDraftListingUnavailable("consumer-unbound"));
    },
  };
}
