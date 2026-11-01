import { describe, expect, it, vi } from "vitest";
import {
  inventoryDraftListingMessageSchema,
  canonicalInventoryDraftListingIntent,
  listingIdForInventoryDraftRow,
} from "@chase-sets/inventory-draft-listing";
import { directPortInput, draftContext, draftMessage, type InventorySnapshotDraftInput } from "./issue-7169-c4-fixture";
import { createInventoryDraftListingConsumer, InventoryDraftListingUnavailable } from "../api/inventory-draft-consumer";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { normalizeAddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { parseGlobalPosition, type StoredEvent } from "@chase-sets/event-core/storage";
import type { PgPoolClient, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { module as marketplaceModule } from "../../../index";
import { inventoryDraftReceiptMigrations } from "../read-model/inventory-draft-receipt-schema";
import type { BcSchemaMigrationClient } from "@chase-sets/bounded-context-module";
import { decideMarketplaceListing, initialMarketplaceListingState, type CreateListingCommand } from "../domain/domain";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { normalizeMarketplaceListingFeeLock } from "../domain/fee-lock";

describe("issue-7169-c4-draft-receipt", () => {
  it("binds the committed row to a deterministic message and listing identity", () => {
    expect(inventoryDraftListingMessageSchema.parse(draftMessage())).toEqual(draftMessage());
    expect(listingIdForInventoryDraftRow("imr_c4_1")).toBe("lst_c4_1");
    expect(inventoryDraftListingMessageSchema.safeParse({ ...draftMessage(), messageId: "imr_other" }).success).toBe(
      false,
    );
  });

  it.each([
    { field: "top-level unknown", change: { rawCsv: "private" } },
    { field: "version", change: { schemaVersion: "inventory-draft-listing/v2" } },
    { field: "date-only", change: { snapshot: { ...draftMessage().snapshot, committedAt: "2026-10-19" } } },
    {
      field: "timezone missing",
      change: { snapshot: { ...draftMessage().snapshot, committedAt: "2026-10-19T12:00:00" } },
    },
    { field: "numeric quantity", change: { snapshot: { ...draftMessage().snapshot, quantityCap: "2" } } },
    {
      field: "nested unknown",
      change: {
        snapshot: {
          ...draftMessage().snapshot,
          selectedOptions: [{ dimensionId: "d", optionId: "o", secret: "private" }],
        },
      },
    },
    {
      field: "address unknown",
      change: {
        snapshot: {
          ...draftMessage().snapshot,
          shipFromAddress: { ...draftMessage().snapshot.shipFromAddress, url: "private" },
        },
      },
    },
  ])("rejects $field before mutation", ({ change }) => {
    expect(inventoryDraftListingMessageSchema.safeParse({ ...draftMessage(), ...change }).success).toBe(false);
  });

  it("canonicalizes formatting but preserves null/presence and committed intent", () => {
    const message = draftMessage();
    expect(
      canonicalInventoryDraftListingIntent({
        ...message,
        snapshot: { ...message.snapshot, priceAmount: "10", committedAt: "2026-10-19T07:00:00-05:00" },
      }),
    ).toBe(canonicalInventoryDraftListingIntent(message));
    expect(
      canonicalInventoryDraftListingIntent({
        ...message,
        snapshot: { ...message.snapshot, shipFromAddress: { ...message.snapshot.shipFromAddress, line2: null } },
      }),
    ).not.toBe(canonicalInventoryDraftListingIntent(message));
    expect(
      canonicalInventoryDraftListingIntent({ ...message, snapshot: { ...message.snapshot, quantityCap: 1 } }),
    ).not.toBe(canonicalInventoryDraftListingIntent(message));
  });
});

function harness() {
  let events: StoredEvent[] = [];
  let receipts: Record<string, unknown>[] = [];
  let savedEvents: StoredEvent[] = [];
  let savedReceipts: Record<string, unknown>[] = [];
  let kill: "draft" | "receipt" | "commit" | "reply" | null = null;
  const queries: string[] = [];
  let createdOptions: readonly { dimensionId: string; optionId: string }[] | null = null;
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("AS ready")) return { rows: [{ ready: true }] };
    if (sql === "BEGIN") {
      savedEvents = [...events];
      savedReceipts = [...receipts];
    }
    if (sql === "ROLLBACK") {
      events = savedEvents;
      receipts = savedReceipts;
    }
    if (sql === "COMMIT") {
      if (kill === "commit") throw new Error("synthetic commit failure");
      savedEvents = [...events];
      savedReceipts = [...receipts];
      if (kill === "reply") throw new Error("synthetic accepted reply loss");
    }
    if (sql.includes("FROM marketplace_inventory_draft_receipts")) {
      return { rows: receipts.filter((row) => row.message_id === values[0]) };
    }
    if (sql.includes("FROM event_store_streams"))
      return { rows: events.length ? [{ current_version: events.length }] : [] };
    if (sql.includes("INSERT INTO marketplace_inventory_draft_receipts")) {
      if (kill === "receipt") throw new Error("synthetic receipt failure");
      receipts.push({
        message_id: values[0],
        tenant_id: values[1],
        account_id: values[2],
        performed_by_user_id: values[3],
        listing_id: values[4],
        intent_hash: values[5],
        receipt: JSON.parse(String(values[6])),
        accepted_at: String(values[7]),
      });
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as PgPoolClient;
  const pool = { query, connect: vi.fn(async () => client) } as PgTransactionalPool;
  const eventStore: PostgresEventStore = {
    ...createInMemoryEventStore().eventStore,
    readStreamInTransaction: async (_client, input) =>
      events.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit),
    appendToStreamInTransaction: vi.fn(),
    appendToStreamsInTransaction: vi.fn(),
  };
  function seedLegacy(message = draftMessage(), commandOverrides: Partial<CreateListingCommand> = {}) {
    const input = { ...directPortInput(), priceCurrencyCode: message.snapshot.priceCurrencyCode };
    const command: CreateListingCommand = {
      type: "CreateListing",
      listingId: input.listingIdOverride,
      accountId: input.accountId as never,
      inventoryItemId: input.inventoryItemId,
      catalogItemId: input.catalogItemId as never,
      productId: input.productId as never,
      itemLanguageCode: null,
      itemTitle: null,
      itemSubtitle: null,
      selectedOptions: input.selectedOptions,
      productSummary: null,
      gradedCard: null,
      storageLocationName: input.storageLocationName,
      shipFromCode: input.shipFromCode,
      shipFromAddress: input.shipFromAddress,
      priceAmount: input.priceAmount,
      priceCurrencyCode: input.priceCurrencyCode,
      feeLock: {
        unitCount: input.quantityCap,
        terms: {
          marketplaceSalesFeePercentageBps: 0,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: null,
          shippingAllowancePercentageBps: 0,
          termsScheduleId: "cts_c4",
          termsAgreementId: null,
          termsResolvedAt: message.snapshot.committedAt,
        },
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: input.priceAmount,
        feeQuoteFingerprint: "quote_c4",
      },
      quantityCap: input.quantityCap,
      evidenceRequirements: {
        policyId: null,
        policyVersion: null,
        policyHash: "policy_c4",
        evaluatedAt: message.snapshot.committedAt,
        requirementHash: "hash_c4",
        matchedRuleIds: [],
        explanationCodes: [],
        requirements: {
          minimumPhotoCount: 0,
          requiredSlots: [],
          sellerTrustRequirements: [],
          buyerAcknowledgment: "none",
        },
      },
    };
    const [created] = decideMarketplaceListing(initialMarketplaceListingState, { ...command, ...commandOverrides });
    events.push({
      eventId: "evt_c4",
      streamId: "marketplace.listing-lst_c4_1",
      streamVersion: 1,
      globalPosition: parseGlobalPosition("1"),
      tenantId: draftContext.tenantId,
      forAccountId: draftContext.audit.forAccountId,
      performedByUserId: draftContext.audit.performedByUserId,
      eventType: "marketplace.listing.created",
      occurredAt: parseIsoUtcTimestamp(message.snapshot.committedAt),
      recordedAt: parseIsoUtcTimestamp(message.snapshot.committedAt),
      metadata: {},
      payload: {
        ...created!.data,
        feeQuoteFingerprint: "quote_c4",
      },
    } satisfies StoredEvent);
  }
  const createDraft = vi.fn(async (_input: { priceCurrencyCode: string }) => {
    if (kill === "draft") throw new Error("synthetic death after draft facts");
    seedLegacy({
      ...draftMessage(),
      snapshot: { ...draftMessage().snapshot, priceCurrencyCode: _input.priceCurrencyCode },
    });
    if (createdOptions) {
      const event = events[0]!;
      events = [{ ...event, payload: { ...event.payload, selectedOptions: createdOptions } }];
    }
    return { listingId: "lst_c4_1" as never, version: 1, feeQuoteFingerprint: "quote_c4" };
  });
  const consumer = createInventoryDraftListingConsumer({
    pool,
    eventStore,
    createListings: () => ({ createBatchDraftListingFromInventorySnapshot: createDraft }),
  });
  return {
    consumer,
    pool,
    client,
    eventStore,
    query,
    queries,
    createDraft,
    seedLegacy,
    events: () => events,
    receipts: () => receipts,
    kill: (at: typeof kill) => {
      kill = at;
    },
    replaceEvents: (next: StoredEvent[]) => {
      events = next;
    },
    setCreatedOptions: (next: readonly { dimensionId: string; optionId: string }[] | null) => {
      createdOptions = next;
    },
  };
}

describe("issue-7169-c4-draft-receipt transaction", () => {
  it("returns one immutable receipt on repeated and day-after delivery without creating or projecting again", async () => {
    const h = harness();
    const receipt = await h.consumer.accept(draftMessage(), draftContext);
    const before = h.queries.length;
    expect(await h.consumer.accept(draftMessage(), draftContext)).toEqual(receipt);
    expect(await h.consumer.readReceipt(receipt.messageId, draftContext)).toEqual(receipt);
    expect(h.createDraft).toHaveBeenCalledTimes(1);
    expect(h.events()).toHaveLength(1);
    expect(h.receipts()).toHaveLength(1);
    expect(h.queries.slice(before).some((sql) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
  });

  it("forwards exactly the typed direct-port keys and preserves CAD", async () => {
    const h = harness();
    const message = { ...draftMessage(), snapshot: { ...draftMessage().snapshot, priceCurrencyCode: "CAD" } };
    await h.consumer.accept(message, draftContext);
    expect(Object.keys(h.createDraft.mock.calls[0]![0] as object).sort()).toEqual(
      [...Object.keys(directPortInput()), "acquisitionCostCurrencyCode"].sort(),
    );
    expect((h.createDraft.mock.calls[0]![0] as { priceCurrencyCode: string }).priceCurrencyCode).toBe("CAD");
  });

  it("forwards an amount-only acquisition cost without inventing its denomination", async () => {
    const h = harness();
    const message = {
      ...draftMessage(),
      snapshot: { ...draftMessage().snapshot, acquisitionCostAmount: "12.34", priceCurrencyCode: "CAD" },
    };
    await h.consumer.accept(message, draftContext);
    const input = h.createDraft.mock.calls[0]![0] as InventorySnapshotDraftInput;
    expect(input.acquisitionCostAmount).toBe("12.34");
    expect(input).toHaveProperty("acquisitionCostCurrencyCode", undefined);
  });

  it("pins consumer input parity to the Marketplace snapshot-draft parameter type", async () => {
    const h = harness();
    await h.consumer.accept(draftMessage(), draftContext);
    const keys: Record<keyof InventorySnapshotDraftInput, true> = {
      accountId: true,
      importBatchId: true,
      importRowId: true,
      inventoryItemId: true,
      listingIdOverride: true,
      catalogItemId: true,
      productId: true,
      selectedOptions: true,
      storageLocationId: true,
      storageLocationName: true,
      shipFromCode: true,
      shipFromAddress: true,
      totalQuantity: true,
      acquisitionCostAmount: true,
      acquisitionCostCurrencyCode: true,
      priceAmount: true,
      priceCurrencyCode: true,
      quantityCap: true,
    };
    expect(Object.keys(h.createDraft.mock.calls[0]![0] as object).sort()).toEqual(Object.keys(keys).sort());
  });

  it.each(["draft", "receipt", "commit"] as const)(
    "rolls back facts and receipt on %s death (receipt-after-draft-commit control)",
    async (at) => {
      const h = harness();
      h.kill(at);
      await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
        code: "inventory-draft-unavailable",
        diagnostic: "unexpected-failure",
      });
      expect(h.events()).toHaveLength(0);
      expect(h.receipts()).toHaveLength(0);
      h.kill(null);
      await h.consumer.accept(draftMessage(), draftContext);
      expect(h.events()).toHaveLength(1);
      expect(h.receipts()).toHaveLength(1);
    },
  );

  it("reconciles an accepted-but-lost reply by exact receipt lookup, without another creation", async () => {
    const h = harness();
    h.kill("reply");
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "unexpected-failure",
    });
    const stored = await h.consumer.readReceipt("imr_c4_1", draftContext);
    expect(stored).not.toBeNull();
    h.kill(null);
    expect(await h.consumer.accept(draftMessage(), draftContext)).toEqual(stored);
    expect(h.createDraft).toHaveBeenCalledTimes(1);
  });

  it("privately rejects changed snapshot, authority and version (message-intent-unchecked control)", async () => {
    const h = harness();
    const message = draftMessage();
    const receipt = await h.consumer.accept(message, draftContext);
    for (const changed of [
      { ...message, snapshot: { ...message.snapshot, priceAmount: "11.00" } },
      { ...message, schemaVersion: "inventory-draft-listing/v2" },
      { ...message, authority: { ...message.authority, accountId: "acc_other" } },
    ])
      await expect(h.consumer.accept(changed, draftContext)).rejects.toMatchObject({
        code: "inventory-draft-conflict",
      });
    const other = { ...draftContext, audit: { ...draftContext.audit, forAccountId: "acc_other" as never } };
    await expect(
      h.consumer.accept({ ...message, authority: { ...message.authority, accountId: "acc_other" } }, other),
    ).rejects.toMatchObject({ code: "inventory-draft-conflict" });
    expect(await h.consumer.readReceipt(message.messageId, other)).toBeNull();
    expect(await h.consumer.readReceipt("imr_missing", other)).toBeNull();
    expect(await h.consumer.readReceipt(message.messageId, draftContext)).toEqual(receipt);
    expect(h.events()).toHaveLength(1);
    expect(h.receipts()).toHaveLength(1);
  });

  it("rejects malformed nested input before acquiring a connection", async () => {
    const h = harness();
    await expect(h.consumer.accept({ ...draftMessage(), rawCsv: "do not retain" }, draftContext)).rejects.toMatchObject(
      { code: "inventory-draft-conflict" },
    );
    expect(h.pool.connect).not.toHaveBeenCalled();
    await expect(
      h.consumer.accept(
        {
          ...draftMessage(),
          snapshot: {
            ...draftMessage().snapshot,
            gradedCard: {
              gradingCompany: "unknown",
              grade: "10",
              certificationNumber: "12345678",
              population: null,
              conditionDescriptors: [],
            },
          },
        },
        draftContext,
      ),
    ).rejects.toMatchObject({ code: "inventory-draft-conflict" });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it("issue-7169-c4-terminal-classification enforces every message-derived create rule", async () => {
    const boundaryCases = [
      {
        valid: { priceAmount: "0.01" },
        invalid: { priceAmount: "0.00" },
      },
      {
        valid: { priceCurrencyCode: "USD" },
        invalid: { priceCurrencyCode: "US" },
      },
      {
        valid: { totalQuantity: 1 },
        invalid: { totalQuantity: 0 },
      },
      {
        valid: { quantityCap: 1, totalQuantity: 1 },
        invalid: { quantityCap: 0 },
      },
      {
        valid: { quantityCap: 2, totalQuantity: 2 },
        invalid: { quantityCap: 3, totalQuantity: 2 },
      },
      {
        valid: { shipFromAddress: { ...draftMessage().snapshot.shipFromAddress, line1: "A" } },
        invalid: { shipFromAddress: { ...draftMessage().snapshot.shipFromAddress, line1: "" } },
      },
    ] as const;

    for (const boundaryCase of boundaryCases) {
      const accepted = harness();
      accepted.seedLegacy({
        ...draftMessage(),
        snapshot: { ...draftMessage().snapshot, ...boundaryCase.valid },
      });
      expect(accepted.events()).toHaveLength(1);

      const rejected = harness();
      await expect(
        rejected.consumer.accept(
          { ...draftMessage(), snapshot: { ...draftMessage().snapshot, ...boundaryCase.invalid } },
          draftContext,
        ),
      ).rejects.toMatchObject({ code: "inventory-draft-conflict" });
      expect(rejected.pool.connect).not.toHaveBeenCalled();
      expect(rejected.events()).toHaveLength(0);
      expect(rejected.receipts()).toHaveLength(0);
    }
  });

  it("issue-7169-c4-unavailable-diagnostics preserves mutable causes and rollback", async () => {
    const h = harness();
    h.createDraft.mockImplementation(async () => {
      normalizeMarketplaceListingFeeLock({
        unitCount: 2,
        terms: {
          marketplaceSalesFeePercentageBps: 10_001,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: null,
          shippingAllowancePercentageBps: 0,
          termsScheduleId: "commercial-terms-quote",
          termsAgreementId: "agreement-c4",
          termsResolvedAt: draftMessage().snapshot.committedAt,
        },
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: "10.00",
        feeQuoteFingerprint: "quote-c4",
      });
      throw new Error("Expected fee-lock normalization to reject the quote");
    });
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "listing-rejected",
    });
    expect(h.queries.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(h.events()).toHaveLength(0);
    expect(h.receipts()).toHaveLength(0);

    const evidence = harness();
    evidence.createDraft.mockRejectedValue(new Error("evidence requirements unavailable"));
    await expect(evidence.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "unexpected-failure",
    });
    expect(evidence.queries.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(evidence.events()).toHaveLength(0);
    expect(evidence.receipts()).toHaveLength(0);

    const storage = harness();
    storage.kill("receipt");
    await expect(storage.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "unexpected-failure",
    });
    expect(storage.queries.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(storage.events()).toHaveLength(0);
    expect(storage.receipts()).toHaveLength(0);

    const readiness = harness();
    const original = readiness.query.getMockImplementation()!;
    readiness.query.mockImplementation(async (sql, values) =>
      sql.includes("AS ready") ? { rows: [{ ready: false }] } : original(sql, values),
    );
    await expect(readiness.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "receipt-ledger-not-ready",
    });
    await expect(readiness.consumer.readReceipt(draftMessage().messageId, draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "receipt-ledger-not-ready",
    });
    expect(readiness.events()).toHaveLength(0);
    expect(readiness.receipts()).toHaveLength(0);

    const rewrapped = harness();
    rewrapped.createDraft.mockRejectedValue(new InventoryDraftListingUnavailable("listing-rejected"));
    await expect(rewrapped.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "listing-rejected",
    });
  });

  it("issue-7169-c4-diagnostic-secret-free scrubs message and cause on every unavailable path", async () => {
    const assertSecretFree = (error: unknown, secret: string, diagnostic: string) => {
      expect(error).toMatchObject({ code: "inventory-draft-unavailable", diagnostic });
      expect(error).toBeInstanceOf(Error);
      const record = error as Error & { diagnostic?: string };
      expect(record.message).not.toContain(secret);
      expect(record.diagnostic).toBe(diagnostic);
      for (const key of Object.getOwnPropertyNames(record)) {
        expect(key).not.toContain(secret);
        expect(String((record as unknown as Record<string, unknown>)[key])).not.toContain(secret);
      }
      expect(JSON.stringify(record)).not.toContain(secret);
    };

    const domain = harness();
    const domainSecret = "Bearer domain-secret-marker";
    domain.createDraft.mockImplementation(async () => {
      const error = new MarketplaceListingDomainError("command-rejected", domainSecret);
      Object.defineProperty(error, "cause", { value: domainSecret, enumerable: false });
      throw error;
    });
    const domainError = await domain.consumer.accept(draftMessage(), draftContext).catch((value) => value);
    assertSecretFree(domainError, domainSecret, "listing-rejected");

    const plain = harness();
    const plainSecret = "Bearer plain-secret-marker";
    plain.createDraft.mockImplementation(async () => {
      throw new Error(plainSecret, { cause: plainSecret });
    });
    const plainError = await plain.consumer.accept(draftMessage(), draftContext).catch((value) => value);
    assertSecretFree(plainError, plainSecret, "unexpected-failure");

    const receipt = harness();
    const receiptSecret = "Bearer receipt-secret-marker";
    receipt.query.mockImplementation(async (sql) => {
      if (sql.includes("AS ready")) return { rows: [{ ready: true }] };
      throw new Error(receiptSecret, { cause: receiptSecret });
    });
    const readError = await receipt.consumer
      .readReceipt(draftMessage().messageId, draftContext)
      .catch((value) => value);
    assertSecretFree(readError, receiptSecret, "unexpected-failure");
  });
});

describe("issue-7169-c4-consumer-rollout", () => {
  it("checks every retained receipt page, including decisive poison beyond the first 500", async () => {
    const h = harness();
    const receipt = await h.consumer.accept(draftMessage(), draftContext);
    const rows = Array.from({ length: 501 }, (_, i) => {
      const messageId = `imr_page_${String(i).padStart(4, "0")}`;
      const listingId = messageId.replace("imr_", "lst_");
      return {
        ...h.receipts()[0],
        message_id: messageId,
        listing_id: listingId,
        receipt: { ...receipt, messageId, importRowId: messageId, listingId },
      };
    });
    rows[500]!.receipt.schemaVersion = "poison" as never;
    const cursors: unknown[] = [];
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("AS valid")) return { rows: [{ valid: true }] };
      if (sql.includes("ORDER BY message_id LIMIT 500")) {
        cursors.push(values[0]);
        return { rows: values[0] === null ? rows.slice(0, 500) : rows.slice(500) };
      }
      return { rows: [] };
    });
    await expect(inventoryDraftReceiptMigrations[0]!.dataStep!({ query } as BcSchemaMigrationClient)).rejects.toThrow(
      "Invalid Inventory draft receipt history.",
    );
    expect(cursors).toEqual([null, "imr_page_0499"]);
  });
  it("refuses before draft writes when the exact ledger/trigger prerequisite is missing (consumer-schema-after-writer control)", async () => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) =>
      sql.includes("AS ready") ? { rows: [{ ready: false }] } : original(sql, values),
    );
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "receipt-ledger-not-ready",
    });
    expect(h.createDraft).not.toHaveBeenCalled();
    expect(h.events()).toHaveLength(0);
    expect(h.receipts()).toHaveLength(0);
  });
  it("installs the durable ledger schema before writers (consumer-schema-after-writer control)", () => {
    expect(marketplaceModule.schemaMigrations?.[0]).toBe(inventoryDraftReceiptMigrations[0]);
    expect(inventoryDraftReceiptMigrations[0]?.dataStep).toBeTypeOf("function");
    expect(inventoryDraftReceiptMigrations[0]?.statements.join("\n")).toContain("BEFORE UPDATE OR DELETE");
  });
  it("reconciles the exact pre-receipt direct-port draft without creator/projection calls (legacy-draft-duplicated control)", async () => {
    const h = harness();
    h.seedLegacy();
    const receipt = await h.consumer.accept(draftMessage(), draftContext);
    expect(receipt.source).toBe("legacy-draft");
    expect(h.createDraft).not.toHaveBeenCalled();
    expect(h.events()).toHaveLength(1);
    expect(h.receipts()).toHaveLength(1);
    expect(await h.consumer.accept(draftMessage(), draftContext)).toEqual(receipt);
  });

  it.each([
    {
      name: "changed optionId",
      options: [
        { dimensionId: "a", optionId: "oa_changed" },
        { dimensionId: "z", optionId: "oz" },
      ],
    },
    { name: "missing dimension", options: [{ dimensionId: "a", optionId: "oa" }] },
    {
      name: "extra dimension",
      options: [
        { dimensionId: "a", optionId: "oa" },
        { dimensionId: "m", optionId: "om" },
        { dimensionId: "z", optionId: "oz" },
      ],
    },
  ])("rejects a legacy draft with $name options", async ({ options }) => {
    const h = harness();
    h.seedLegacy();
    const event = h.events()[0]!;
    h.replaceEvents([{ ...event, payload: { ...event.payload, selectedOptions: options } }]);
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-conflict",
    });
    expect(h.createDraft).not.toHaveBeenCalled();
    expect(h.receipts()).toHaveLength(0);
  });

  it("rejects malformed and non-null legacy option/limit payloads", async () => {
    for (const selectedOptions of [
      [{ dimensionId: "a", optionId: "oa", unexpected: true }],
      [
        { dimensionId: "a", optionId: "oa" },
        { dimensionId: "a", optionId: "oa_again" },
      ],
    ]) {
      const h = harness();
      h.seedLegacy();
      const event = h.events()[0]!;
      h.replaceEvents([{ ...event, payload: { ...event.payload, selectedOptions } }]);
      await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
        code: "inventory-draft-conflict",
      });
      expect(h.createDraft).not.toHaveBeenCalled();
      expect(h.receipts()).toHaveLength(0);
    }
    const h = harness();
    h.seedLegacy();
    const event = h.events()[0]!;
    h.replaceEvents([
      {
        ...event,
        payload: {
          ...event.payload,
          purchaseLimits: { maxUnitsPerOrder: 1, maxUnitsPerDay: 1, maxUnitsPerCustomerAccount: 1 },
        },
      },
    ]);
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-conflict",
    });
    expect(h.createDraft).not.toHaveBeenCalled();
    expect(h.receipts()).toHaveLength(0);
  });

  it("rejects message-path creator drift in selected options", async () => {
    const h = harness();
    h.setCreatedOptions([{ dimensionId: "a", optionId: "oa_changed" }]);
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-conflict",
    });
    expect(h.receipts()).toHaveLength(0);
  });

  it.each(["owner", "snapshot", "duplicate", "poison", "post-terminal"])(
    "fails closed on %s legacy history",
    async (change) => {
      const h = harness();
      h.seedLegacy();
      const event = h.events()[0]!;
      if (change === "owner") h.replaceEvents([{ ...event, tenantId: "tnt_other" as never }]);
      if (change === "snapshot") h.replaceEvents([{ ...event, payload: { ...event.payload, priceAmount: "99.00" } }]);
      if (change === "duplicate") h.replaceEvents([event, { ...event, streamVersion: 2 }]);
      if (change === "poison") h.replaceEvents([{ ...event, eventType: "marketplace.listing.unknown" }]);
      if (change === "post-terminal")
        h.replaceEvents([
          event,
          { ...event, streamVersion: 2, eventType: "marketplace.listing.published", payload: {} },
        ]);
      await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
        code: "inventory-draft-conflict",
      });
      expect(h.createDraft).not.toHaveBeenCalled();
      expect(h.receipts()).toHaveLength(0);
    },
  );

  it("rejects truncated authoritative history even when the returned page is short", async () => {
    const h = harness();
    h.seedLegacy();
    const first = h.events()[0]!;
    h.replaceEvents([first, { ...first, streamVersion: 2 }]);
    h.eventStore.readStreamInTransaction = async () => [first];
    await expect(h.consumer.accept(draftMessage(), draftContext)).rejects.toMatchObject({
      code: "inventory-draft-conflict",
    });
    expect(h.receipts()).toHaveLength(0);
  });
});
