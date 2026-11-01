import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createInventoryItemRuntime, type InventoryItemServices } from "./runtime";
import type { InventoryCatalogItemServices } from "../integrations/catalog/runtime";
import type { InventoryProductSchema } from "../integrations/catalog/versioning";
import { evolveInventoryItem, initialInventoryItemState } from "../domain/domain";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_inventory" as never,
  audit: {
    performedByUserId: "usr_seller" as never,
    forAccountId: "acc_seller" as never,
  },
};

const shipFromAddress = {
  name: "Seller Shipping",
  line1: "1 Warehouse Way",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

describe("inventory create runtime graded boundaries", () => {
  const MISSING_DETAILS = "Choose a grading company and grade before creating a Graded inventory item.";
  const REQUIRES_DETAILS = "Graded inventory items require graded card details.";
  const RAW_DETAILS = "Graded card details are only allowed for graded inventory items.";
  const whenGraded = [{ dimensionId: "form", optionIds: ["opt_graded"] }];
  const formDimension = (
    options: ReadonlyArray<readonly [string, string]> = [
      ["opt_raw", "Raw"],
      ["opt_graded", "Graded"],
    ],
    name = "Form",
  ) => ({
    dimensionId: "form",
    dimensionName: name,
    required: true,
    appliesWhen: [],
    allowedOptions: options.map(([optionId, label]) => ({ optionId, code: optionId, label })),
  });
  const companyDimension = (required: boolean) => ({
    dimensionId: "company",
    dimensionName: "Grading Company",
    required,
    appliesWhen: whenGraded,
    allowedOptions: [{ optionId: "opt_psa", code: "psa", label: "PSA" }],
  });
  const gradeDimension = (required: boolean) => ({
    dimensionId: "grade",
    dimensionName: "Grade",
    required,
    appliesWhen: whenGraded,
    allowedOptions: [{ optionId: "opt_ten", code: "ten", label: "10" }],
  });
  function productSchema(...dimensions: InventoryProductSchema["dimensions"]): InventoryProductSchema {
    return {
      canonicalDimensionOrder: dimensions.map(({ dimensionId, dimensionName }) => ({ dimensionId, dimensionName })),
      dimensions,
    };
  }
  const schemas: Record<string, InventoryProductSchema | null> = {
    cat_required: productSchema(formDimension(), companyDimension(true), gradeDimension(true)),
    cat_optional: productSchema(formDimension(), companyDimension(false), gradeDimension(false)),
    cat_no_company: productSchema(formDimension(), gradeDimension(true)),
    cat_no_grade: productSchema(formDimension(), companyDimension(true)),
    cat_slab: productSchema(formDimension([["opt_graded", "Graded (Slab)"]])),
    cat_card_form: productSchema(formDimension([["opt_graded", "Graded"]], "Card Form")),
    cat_unstructured: null,
  };
  const gradedOptions = [
    { dimensionId: "form", optionId: "opt_graded" },
    { dimensionId: "company", optionId: "opt_psa" },
    { dimensionId: "grade", optionId: "opt_ten" },
  ];
  const rawOptions = [{ dimensionId: "form", optionId: "opt_raw" }];

  function setup() {
    const { eventStore, streams } = createInMemoryEventStore();
    const locations = ["acc_seller", "acc_other"].map((accountId) => ({
      storage_location_id: `loc_${accountId}`,
      account_id: accountId,
      name: "Main shelf",
      description: null,
      ship_from_code: "MAIN",
      ship_from_address: shipFromAddress,
      is_archived: false,
    }));
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[]) => {
        if (!sql.includes("FROM inventory_storage_locations")) throw new Error(`Unexpected query: ${sql}`);
        return {
          rows: locations.filter(
            (location) =>
              location.storage_location_id === values[0] &&
              (!sql.includes("account_id = $2") || location.account_id === values[1]),
          ),
        };
      }),
    };
    const catalogItems: InventoryCatalogItemServices = {
      getCatalogItem: vi.fn(async (catalogItemId: string) =>
        catalogItemId in schemas
          ? {
              catalog_item_id: catalogItemId,
              language_code: "en",
              title: "Charizard",
              subtitle: null,
              blueprint_id: null,
              status: "active",
              product_schema: schemas[catalogItemId] ?? null,
              updated_at: "2026-11-01T00:00:00.000Z",
            }
          : null,
      ),
      getExternalProductReference: vi.fn(async () => null),
      getExternalCatalogItemReference: vi.fn(async () => null),
      getCatalogItemByGtin: vi.fn(async () => null),
      projectors: [],
    };
    const runtime = createInventoryItemRuntime(
      { eventStore, db: db as never, checkpointStore: createCheckpointStore() },
      catalogItems,
      { listStorageLocations: vi.fn() } as never,
    );
    return { runtime, eventStore, streams, db };
  }

  type CreateInput = Omit<
    Parameters<InventoryItemServices["createItem"]>[0],
    "accountId" | "storageLocationId" | "totalQuantity"
  >;
  function create(input: CreateInput, harness = setup()) {
    return harness.runtime.createItem(
      { accountId: "acc_seller" as never, storageLocationId: "loc_acc_seller", totalQuantity: 2, ...input },
      context,
    );
  }

  async function createdPayload(input: CreateInput) {
    const harness = setup();
    const result = await create(input, harness);
    const events = await harness.eventStore.readStream({ streamId: `inventory.item-${result.itemId}` });
    expect(events.map((event) => event.eventType)).toEqual(["inventory.item.created"]);
    const state = evolveInventoryItem(initialInventoryItemState, {
      type: "inventory.item.created",
      data: events[0].payload,
    } as never);
    expect(state.gradedCard).toEqual((events[0].payload as { gradedCard: unknown }).gradedCard);
    return events[0].payload as Record<string, unknown>;
  }

  async function expectRefusedWithoutWrites(input: CreateInput, message: string) {
    const harness = setup();
    await expect(create(input, harness)).rejects.toThrow(message);
    expect(harness.streams.size).toBe(0);
  }

  it.each([
    ["cert-123", "cert-123"],
    ["  cert-123  ", "cert-123"],
    [null, null],
    ["   ", null],
  ])("derives the graded card from the selected options with certification %j", async (certificationNumber, stored) => {
    const payload = await createdPayload({
      catalogItemId: "cat_required",
      selectedOptions: gradedOptions,
      certificationNumber,
    });
    expect(payload).toMatchObject({
      accountId: "acc_seller",
      selectedOptions: gradedOptions,
      gradedCard: {
        gradingCompany: "PSA",
        grade: "10",
        certificationNumber: stored,
        population: null,
        conditionDescriptors: [],
      },
      storageLocationId: "loc_acc_seller",
      totalQuantity: 2,
    });
  });

  it("refuses a Graded create that omits the certification member, which only older clients do", async () => {
    await expectRefusedWithoutWrites(
      { catalogItemId: "cat_required", selectedOptions: gradedOptions },
      REQUIRES_DETAILS,
    );
    await expect(
      createdPayload({ catalogItemId: "cat_required", selectedOptions: gradedOptions, certificationNumber: null }),
    ).resolves.toMatchObject({ gradedCard: { gradingCompany: "PSA" } });
  });

  it.each([
    ["Grading Company", "company"],
    ["Grade", "grade"],
  ])("keeps the shipped schema error when required %s is omitted", async (dimensionName, dimensionId) => {
    await expectRefusedWithoutWrites(
      {
        catalogItemId: "cat_required",
        selectedOptions: gradedOptions.filter((option) => option.dimensionId !== dimensionId),
        certificationNumber: "cert-123",
      },
      `Selected options must include ${dimensionName}.`,
    );
  });

  it.each([
    ["optional company not chosen", "cat_optional", ["form", "grade"]],
    ["optional grade not chosen", "cat_optional", ["form", "company"]],
    ["company absent from the schema", "cat_no_company", ["form", "grade"]],
    ["grade absent from the schema", "cat_no_grade", ["form", "company"]],
  ])("answers the missing-details text when the %s", async (_name, catalogItemId, dimensionIds) => {
    await expectRefusedWithoutWrites(
      {
        catalogItemId,
        selectedOptions: gradedOptions.filter((option) => dimensionIds.includes(option.dimensionId)),
        certificationNumber: "cert-123",
      },
      MISSING_DETAILS,
    );
  });

  it("creates when the optional company and grade are both chosen", async () => {
    await expect(
      createdPayload({
        catalogItemId: "cat_optional",
        selectedOptions: gradedOptions,
        certificationNumber: "cert-123",
      }),
    ).resolves.toMatchObject({ gradedCard: { gradingCompany: "PSA", grade: "10", certificationNumber: "cert-123" } });
  });

  it.each(["cat_slab", "cat_card_form"])(
    "refuses the legacy %s selection instead of creating it raw",
    async (catalogItemId) => {
      await expectRefusedWithoutWrites(
        {
          catalogItemId,
          selectedOptions: [{ dimensionId: "form", optionId: "opt_graded" }],
          certificationNumber: null,
        },
        REQUIRES_DETAILS,
      );
    },
  );

  it.each([{}, { certificationNumber: null }, { certificationNumber: "  " }])(
    "creates raw items unchanged with %j",
    async (certification) => {
      await expect(
        createdPayload({ catalogItemId: "cat_required", selectedOptions: rawOptions, ...certification }),
      ).resolves.toMatchObject({
        selectedOptions: rawOptions,
        gradedCard: null,
      });
      await expect(
        createdPayload({ catalogItemId: "cat_unstructured", selectedOptions: [], ...certification }),
      ).resolves.toMatchObject({
        gradedCard: null,
      });
    },
  );

  it("refuses a non-blank certification number on a raw item", async () => {
    await expectRefusedWithoutWrites(
      { catalogItemId: "cat_required", selectedOptions: rawOptions, certificationNumber: "cert-123" },
      RAW_DETAILS,
    );
  });

  it.each([
    ["raw", rawOptions, undefined],
    ["graded", gradedOptions, "cert-123"],
  ])("refuses another account's storage for %s without writes", async (_form, selectedOptions, certificationNumber) => {
    const harness = setup();
    await expect(
      harness.runtime.createItem(
        {
          accountId: "acc_seller" as never,
          catalogItemId: "cat_required",
          selectedOptions,
          ...(certificationNumber === undefined ? {} : { certificationNumber }),
          storageLocationId: "loc_acc_other",
          totalQuantity: 1,
        },
        context,
      ),
    ).rejects.toThrow("Storage location not found.");
    expect(harness.streams.size).toBe(0);
    expect(harness.db.query).toHaveBeenCalledWith(expect.stringContaining("account_id = $2"), [
      "loc_acc_other",
      "acc_seller",
    ]);
  });
});

describe("inventory item runtime", () => {
  it.each(["load->history", "history->append"] as const)(
    "issue-9598 fences listing-stock top-up across %s and a repeat converges without adjustment",
    async (window) => {
      const { eventStore } = createInMemoryEventStore();
      const itemId = "inv_listing_stock_race";
      const streamId = `inventory.item-${itemId}`;
      const location = {
        storage_location_id: "loc_listing_stock",
        account_id: "acc_seller",
        name: "Listing stock",
        description: null,
        ship_from_code: "LISTING-STOCK",
        ship_from_address: shipFromAddress,
        is_archived: false,
      };
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM inventory_storage_locations")) return { rows: [location] };
          if (sql.includes("FROM inventory_items AS item")) {
            return { rows: [{ item_id: itemId, account_id: "acc_seller", total_quantity: 2, available_quantity: 2 }] };
          }
          if (sql.includes("WITH candidates AS")) return { rows: [] };
          throw new Error(`Unexpected query: ${sql}`);
        }),
      };
      let itemReads = 0;
      const concurrentIntake = async () =>
        eventStore.appendToStream({
          streamId,
          expectedVersion: 1,
          context,
          events: [
            {
              eventType: "inventory.item.adjusted",
              payload: { itemId, quantityDelta: 3, reason: "Concurrent intake" },
            },
          ],
        });
      const topUps: AppendToStreamInput[] = [];
      const interleavedStore: EventStore = {
        ...eventStore,
        readStream: async (input) => {
          if (input.streamId !== streamId || ++itemReads !== 2) return eventStore.readStream(input);
          if (window === "load->history") await concurrentIntake();
          const events = await eventStore.readStream(input);
          expect(events.at(-1)?.streamVersion).toBe(window === "load->history" ? 2 : 1);
          if (window === "history->append") await concurrentIntake();
          return events;
        },
        appendToStream: async (input) => {
          if (input.events.some((event) => event.payload.reason === "Automatic listing stock")) topUps.push(input);
          return eventStore.appendToStream(input);
        },
      };
      const services = createInventoryItemRuntime(
        { eventStore: interleavedStore, db: db as never, checkpointStore: createCheckpointStore() },
        {
          getCatalogItem: vi.fn(async () => ({ catalog_item_id: "cat_1", status: "active", product_schema: null })),
        } as never,
        { listStorageLocations: vi.fn(async () => [location]) } as never,
      );
      await services.commandHandler({
        streamId,
        command: {
          type: "CreateInventoryItem",
          itemId: itemId as never,
          accountId: "acc_seller" as never,
          catalogItemId: "cat_1" as never,
          productId: "cat_1::",
          selectedOptions: [],
          storageLocationId: location.storage_location_id,
          totalQuantity: 2,
          acquisitionOccurrence: { kind: "unknown" },
          commandOccurredAt: "2026-09-07T06:00:00Z",
        },
        context,
      });
      itemReads = 0;
      const request = { accountId: "acc_seller" as never, catalogItemId: "cat_1", selectedOptions: [], quantity: 5 };
      const outcome = await services.ensureListingStock(request, context).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const events = await eventStore.readStream({ streamId });
      const total = events.reduce(
        (quantity, event) =>
          event.eventType === "inventory.item.created"
            ? Number(event.payload.totalQuantity)
            : quantity + Number(event.payload.quantityDelta ?? 0),
        0,
      );
      expect({ version: events.at(-1)?.streamVersion, total }).toEqual({ version: 2, total: 5 });
      expect(outcome).toMatchObject({ error: { code: "concurrency_conflict" } });
      expect(topUps).toHaveLength(1);
      expect(topUps[0].expectedVersion).toBe(1);
      expect(events.filter((event) => event.payload.reason === "Automatic listing stock")).toHaveLength(0);
      const repeat = await services.ensureListingStock(request, context);
      expect(repeat).toMatchObject({ adjustedQuantityBy: 0, snapshot: { totalQuantity: 5, availableQuantity: 5 } });
      expect(await eventStore.readStream({ streamId })).toEqual(events);
      expect(topUps).toHaveLength(1);
    },
  );

  it("issue-6299-acceptance-control recovers beyond 500 events and issue-7054-F1 recovers note-only crash-window retries", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    const ledger = new Map<
      string,
      {
        inserted: boolean;
        command_fingerprint: string;
        claim_generation: string;
        status: "in_progress" | "completed";
        result_item_id: string | null;
        result_version: number | null;
        result_collision: unknown;
        created_at: string;
      }
    >();
    let failNextIdempotencyComplete = false;
    const inventoryRow = {
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::",
      selected_options: [],
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Main",
      ship_from_code: "MAIN",
      total_quantity: 10,
      held_quantity: 0,
      available_quantity: 10,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("WITH inserted")) {
          const key = String(values[0]);
          const existing = ledger.get(key);
          if (existing) {
            return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
          }
          const row = {
            inserted: true,
            command_fingerprint: String(values[3]),
            claim_generation: String(values[4]),
            status: "in_progress" as const,
            result_item_id: null,
            result_version: null,
            result_collision: null,
            created_at: new Date().toISOString(),
          };
          ledger.set(key, row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes("UPDATE inventory_item_adjustment_idempotency")) {
          const key = String(values[0]);
          const existing = ledger.get(key);
          if (failNextIdempotencyComplete) {
            failNextIdempotencyComplete = false;
            throw new Error("ledger complete failed");
          }
          const owned =
            existing?.status === "in_progress" &&
            existing.command_fingerprint === String(values[1]) &&
            existing.claim_generation === String(values[2]);
          if (owned) {
            ledger.set(key, {
              ...existing,
              inserted: false,
              status: "completed",
              result_item_id: String(values[3]),
              result_version: Number(values[4]),
              result_collision: JSON.parse(String(values[5])),
            });
          }
          return {
            rows: [],
            rowCount: owned ? 1 : 0,
          };
        }
        if (sql.includes("DELETE FROM inventory_item_adjustment_idempotency")) {
          const existing = ledger.get(String(values[0]));
          const owned =
            existing?.status === "in_progress" &&
            existing.command_fingerprint === String(values[1]) &&
            existing.claim_generation === String(values[2]);
          if (owned) ledger.delete(String(values[0]));
          return { rows: [], rowCount: owned ? 1 : 0 };
        }
        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: [inventoryRow] };
        }
        if (sql.includes("WITH candidates AS") || sql.includes("FROM inventory_holds")) {
          return { rows: [] };
        }
        if (sql.includes("to_regclass")) {
          return { rows: [{ table_name: null }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(),
      } as never,
      {
        listStorageLocations: vi.fn(),
        createStorageLocation: vi.fn(),
      } as never,
    );
    await services.commandHandler({
      streamId: "inventory.item-inv_1",
      command: {
        type: "CreateInventoryItem",
        acquisitionOccurrence: { kind: "unknown" },
        commandOccurredAt: "2026-09-07T06:00:00Z",
        itemId: "inv_1" as never,
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        storageLocationId: "loc_1",
        totalQuantity: 10,
      },
      context,
    });

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    expect(ledger.get("inventory-import-row:imr_1:adjustment")?.command_fingerprint).toBe(
      "5b7e79c784d1004f25875df18baab87cdf8f6060fe537fa10effd644cfc931bb",
    );
    await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: 2,
      context,
      events: Array.from({ length: 498 }, (_, index) => ({
        eventType: "inventory.item.adjusted",
        payload: {
          itemId: "inv_1",
          quantityDelta: index % 2 === 0 ? 1 : -1,
          reason: "Pagination control",
          sourceRef: null,
        },
      })),
    });
    failNextIdempotencyComplete = true;
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 2,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_2:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("ledger complete failed");
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 2,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_2:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 501 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 4,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "intake",
          note: "  Received at counter  ",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 502 });
    expect(ledger.get("inventory-import-row:imr_extended:adjustment")?.command_fingerprint).toBe(
      "b4e204c1c02147fe9d06473d002e86c17f75808b9c19d4c80331c744dbff7862",
    );
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "intake",
          note: "Different note",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "correction",
          note: "Received at counter",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");

    const noteOnlyCrashWindowCases = [
      {
        name: "note present with reasonCode omitted",
        idempotencyKey: "inventory-import-row:imr_note_only:adjustment",
        note: "  Received at counter  ",
        expectedNote: "Received at counter",
        expectedVersion: 503,
      },
      {
        name: "blank note with reasonCode omitted",
        idempotencyKey: "inventory-import-row:imr_blank_note:adjustment",
        note: "   ",
        expectedNote: null,
        expectedVersion: 504,
      },
    ] as const;

    for (const testCase of noteOnlyCrashWindowCases) {
      const request = {
        accountId: "acc_seller",
        itemId: "inv_1",
        quantityDelta: 1,
        reason: "Counter intake",
        note: testCase.note,
        idempotencyKey: testCase.idempotencyKey,
      } as const;

      failNextIdempotencyComplete = true;
      await expect(services.adjustItem(request, context), testCase.name).rejects.toThrow("ledger complete failed");
      const committed = streams.get("inventory.item-inv_1")?.at(-1);
      expect(committed?.streamVersion, testCase.name).toBe(testCase.expectedVersion);
      expect(committed?.payload, testCase.name).toMatchObject({
        itemId: "inv_1",
        quantityDelta: 1,
        reason: "Counter intake",
        note: testCase.expectedNote,
      });
      expect(committed?.payload, testCase.name).not.toHaveProperty("reasonCode");

      await expect(services.adjustItem(request, context), testCase.name).resolves.toEqual({
        itemId: "inv_1",
        version: testCase.expectedVersion,
      });
      expect(streams.get("inventory.item-inv_1"), testCase.name).toHaveLength(testCase.expectedVersion);
    }
  });

  it("uses aggregate held quantity to enforce the adjustment floor when projections lag", async () => {
    const { eventStore } = createInMemoryEventStore();
    for (const [holdId, quantity] of [
      ["hld_1", 1],
      ["hld_2", 2],
    ] as const) {
      await eventStore.appendToStream({
        streamId: `inventory.hold-${holdId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "inventory.hold.placed",
            payload: {
              holdId,
              accountId: "acc_seller",
              itemId: "inv_1",
              quantity,
              reason: "Existing manual hold",
              notes: null,
              purpose: "manual",
              sourceRef: null,
              expiresAt: null,
            },
          },
        ],
      });
    }
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: [] };
        }
        if (sql.includes("FROM event_store_events")) {
          return {
            rows: [
              {
                stream_id: "inventory.hold-hld_1",
                total: "2",
                current_version: "1",
              },
              {
                stream_id: "inventory.hold-hld_2",
                total: "2",
                current_version: "1",
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(),
      } as never,
      {
        listStorageLocations: vi.fn(),
        createStorageLocation: vi.fn(),
      } as never,
    );
    await services.commandHandler({
      streamId: "inventory.item-inv_1",
      command: {
        type: "CreateInventoryItem",
        acquisitionOccurrence: { kind: "unknown" },
        commandOccurredAt: "2026-09-07T06:00:00Z",
        itemId: "inv_1" as never,
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        storageLocationId: "loc_1",
        totalQuantity: 5,
      },
      context,
    });

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: -2,
          reason: "Cycle count",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: -1,
          reason: "Cycle count",
        },
        context,
      ),
    ).rejects.toThrow("3 units are committed to open orders.");
  });

  it("ensures default listing stock without requiring manual inventory setup", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    let listingStockLocation: {
      storage_location_id: string;
      account_id: string;
      name: string;
      description: string | null;
      ship_from_code: string;
      ship_from_address: typeof shipFromAddress;
      is_archived: boolean;
      updated_at: string;
    } | null = null;
    let existingItem: Record<string, unknown> | null = null;

    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO inventory_storage_locations")) {
          listingStockLocation = {
            storage_location_id: String(values[0]),
            account_id: String(values[1]),
            name: String(values[2]),
            description: String(values[3]),
            ship_from_code: String(values[4]),
            ship_from_address: JSON.parse(String(values[5])) as typeof shipFromAddress,
            is_archived: false,
            updated_at: new Date().toISOString(),
          };
          return { rows: [] };
        }

        if (sql.includes("FROM inventory_storage_locations")) {
          return { rows: listingStockLocation ? [listingStockLocation] : [] };
        }

        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: existingItem ? [existingItem] : [] };
        }
        if (sql.includes("WITH candidates AS")) return { rows: [] };

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const storageLocations = {
      listStorageLocations: vi.fn(async () => (listingStockLocation ? [listingStockLocation] : [])),
      createStorageLocation: vi.fn(async () => ({
        storageLocationId: "loc_listing_stock",
        version: 1,
      })),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(async () => ({
          catalog_item_id: "cat_1",
          status: "active",
          product_schema: null,
        })),
      } as never,
      storageLocations as never,
    );

    const result = await services.ensureListingStock(
      {
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        selectedOptions: [],
        quantity: 2,
        shipFromAddress,
      },
      context,
    );

    expect(result).toMatchObject({
      inventoryItemId: expect.stringMatching(/^inv_listing_stock_/),
      storageLocationId: "loc_listing_stock",
      createdStorageLocation: true,
      createdInventoryItem: true,
      adjustedQuantityBy: 0,
      snapshot: {
        catalogItemId: "cat_1",
        totalQuantity: 2,
        availableQuantity: 2,
        storageLocationName: "Listing stock",
      },
    });
    expect(streams.has(`inventory.item-${result.inventoryItemId}`)).toBe(true);

    existingItem = {
      item_id: result.inventoryItemId,
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::",
      selected_options: [],
      graded_card: null,
      storage_location_id: "loc_listing_stock",
      storage_location_name: "Listing stock",
      ship_from_code: "LISTING-STOCK",
      ship_from_address: shipFromAddress,
      total_quantity: 2,
      held_quantity: 0,
      available_quantity: 2,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
    };
    const toppedUp = await services.ensureListingStock(
      {
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        selectedOptions: [],
        quantity: 4,
        shipFromAddress,
      },
      context,
    );

    expect(toppedUp.adjustedQuantityBy).toBe(2);
    expect(streams.get(`inventory.item-${result.inventoryItemId}`)?.at(-1)?.payload).toMatchObject({
      quantityDelta: 2,
      reasonCode: "intake",
    });
  });
});
