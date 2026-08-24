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
import type { PostageLabelProvider, PostageProviderWebhookGateway } from "@chase-sets/postage-labels";
import { PostageLabelProviderError } from "@chase-sets/postage-labels";
import type { PackagePlan } from "@chase-sets/product-measures";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { recordFulfillmentPostageLabelOperationPending } from "../read-model/queries";
import { createFulfillmentShipmentRuntime } from "./runtime";

function webhookReceiptQueryResult(sql: string, values: readonly unknown[] = []) {
  if (sql.includes("WITH inserted AS") && sql.includes("fulfillment_postage_provider_events")) {
    return {
      rows: [
        {
          provider_event_id: values[0],
          payload_hash: values[11],
          handoff_state: "reserved",
          processing_result: "reserved",
          inserted: true,
        },
      ],
      rowCount: 1,
    };
  }
  if (sql.includes("SET claim_token") && sql.includes("fulfillment_postage_provider_events")) {
    return { rows: [{ provider_event_id: values[0] }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO fulfillment_postage_provider_events")) {
    return { rows: [{ provider_event_id: values[0] }], rowCount: 1 };
  }
  return null;
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const shippingDestinationSnapshot = {
  name: "Buyer",
  company: null,
  line1: "2 Market St",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
} as const;

const shippingOriginSnapshot = {
  name: "Seller",
  company: null,
  line1: "1 Main St",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: null,
  email: null,
} as const;

const parcelShippingPlan: PackagePlan = {
  packagePlanVersion: "measured-package-plan-v1",
  packageCount: 1,
  missingProductIds: [],
  letterEligibility: {
    eligible: false,
    reasons: ["declared-value-requires-parcel"],
  },
  postagePolicySnapshot: {
    policyVersion: "operator-postage-v1",
    parcelRequired: true,
    parcelReasons: ["declared-value-requires-parcel"],
    signatureRequired: true,
    signatureReasons: ["declared-value-requires-signature"],
    insuranceRequired: false,
    insuranceReasons: [],
    insuredValueAmount: null,
    shippingEvidenceTier: "signature-confirmed",
  },
  packages: [
    {
      packageId: "pkg_1",
      mailpieceClass: "parcel",
      lengthInches: 8,
      widthInches: 6,
      heightInches: 2,
      weightOunces: 5.25,
      billableWeightOunces: 6,
      serviceLevel: "standard-parcel",
      productMeasureVersions: ["test-measure-v1"],
    },
  ],
};

const insuredShippingPlan: PackagePlan = {
  ...parcelShippingPlan,
  postagePolicySnapshot: {
    ...parcelShippingPlan.postagePolicySnapshot!,
    insuranceRequired: true,
    insuranceReasons: ["declared-value-requires-insurance"],
    insuredValueAmount: "500.00",
    shippingEvidenceTier: "carrier-insured",
  },
};

const letterShippingPlan: PackagePlan = {
  packagePlanVersion: "measured-package-plan-v1",
  packageCount: 1,
  missingProductIds: [],
  letterEligibility: {
    eligible: true,
    reasons: [],
  },
  postagePolicySnapshot: {
    policyVersion: "operator-postage-v1",
    parcelRequired: false,
    parcelReasons: [],
    signatureRequired: false,
    signatureReasons: [],
    insuranceRequired: false,
    insuranceReasons: [],
    insuredValueAmount: null,
    shippingEvidenceTier: "letter-untracked",
  },
  packages: [
    {
      packageId: "pkg_1",
      mailpieceClass: "letter",
      lengthInches: 9.5,
      widthInches: 4.125,
      heightInches: 0.012,
      weightOunces: 0.47,
      billableWeightOunces: 0.47,
      serviceLevel: "letter",
      productMeasureVersions: ["test-measure-v1"],
    },
  ],
};

const purchasedSandboxLabel = {
  providerName: "sandbox-usps",
  providerMode: "test" as const,
  providerShipmentId: "sandbox_shipment_1",
  providerLabelId: "sandbox_label_1",
  providerRateId: "sandbox_rate_1",
  carrierName: "USPS",
  serviceLevel: "USPS_GROUND_ADVANTAGE",
  labelReference: "sandbox_label_1",
  labelDocumentUrl: "https://sandbox.test/label.pdf",
  trackingIdentifier: "940000000000000000",
  postageAmountCents: 499,
  postageCurrency: "USD",
  purchasedAt: "2026-04-02T00:10:00.000Z",
};

async function seedPackedShipmentAggregate(
  services: ReturnType<typeof createFulfillmentShipmentRuntime>,
  context: Parameters<ReturnType<typeof createFulfillmentShipmentRuntime>["commandHandler"]>[0]["context"],
  shipmentId = "shp_1",
) {
  await services.commandHandler({
    streamId: `fulfillment.shipment-${shipmentId}`,
    command: {
      type: "CreateShipment",
      shipmentId: shipmentId as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      shippingDestinationSnapshot,
      shippingOriginSnapshot,
      shippingPlanSnapshot: parcelShippingPlan,
      lines: [
        {
          lineId: "spl_1" as never,
          orderLineId: "oli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2026-04-02T00:00:00.000Z",
    },
    context,
  });
  await services.commandHandler({
    streamId: `fulfillment.shipment-${shipmentId}`,
    command: {
      type: "StartShipmentPacking",
      startedAt: "2026-04-02T00:03:00.000Z",
    },
    context,
  });
  await services.commandHandler({
    streamId: `fulfillment.shipment-${shipmentId}`,
    command: {
      type: "ConfirmShipmentPackingLine",
      lineId: "spl_1" as never,
      confirmedAt: "2026-04-02T00:04:00.000Z",
    },
    context,
  });
  await services.commandHandler({
    streamId: `fulfillment.shipment-${shipmentId}`,
    command: {
      type: "PrepareShipmentPackage",
      packageCount: 1,
      preparedAt: "2026-04-02T00:05:00.000Z",
    },
    context,
  });
}

function createPackedShipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: "shp_1",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    shipping_destination_snapshot: shippingDestinationSnapshot,
    shipping_origin_snapshot: shippingOriginSnapshot,
    shipping_plan_snapshot: parcelShippingPlan,
    shipping_method: null,
    carrier_name: null,
    label_reference: null,
    label_document_url: null,
    tracking_identifier: null,
    postage_provider_name: null,
    postage_provider_mode: null,
    postage_provider_shipment_id: null,
    postage_provider_label_id: null,
    postage_rate_id: null,
    postage_service_level: null,
    postage_amount_cents: null,
    postage_currency: null,
    label_status: "not-purchased",
    label_error_code: null,
    label_error_message: null,
    label_refund_status: null,
    label_refund_reference: null,
    status: "awaiting-label",
    package_status: "packed",
    package_count: 1,
    current_exception_type: null,
    current_exception_notes: null,
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:05:00.000Z",
    packing_started_at: "2026-04-02T00:03:00.000Z",
    package_prepared_at: "2026-04-02T00:05:00.000Z",
    label_attached_at: null,
    label_voided_at: null,
    cancelled_at: null,
    dispatched_at: null,
    delivered_at: null,
    returned_at: null,
    exception_raised_at: null,
    line_count: 1,
    total_quantity: 1,
    ...overrides,
  };
}

function createPostageOperationDb(shipmentRow = createPackedShipmentRow()) {
  let operation: Record<string, unknown> | null = null;
  const db = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("WITH reserved_operation")) {
        if (!operation || operation.status === "failed") {
          operation = {
            operation_key: params?.[0],
            operation_kind: params?.[1],
            shipment_id: params?.[2],
            provider_name: params?.[3],
            provider_mode: params?.[4],
            idempotency_key: params?.[5],
            request_json: JSON.parse(String(params?.[6] ?? "{}")),
            status: "pending",
            provider_shipment_id: null,
            provider_label_id: null,
            tracking_identifier: null,
            error_message: null,
            created_at: params?.[7],
            updated_at: params?.[7],
            completed_at: null,
          };
          return { rows: [{ ...operation, operation_reserved: true }] };
        }
        return { rows: [{ ...operation, operation_reserved: false }] };
      }

      if (sql.includes("SET status = 'provider-succeeded'")) {
        operation = {
          ...operation,
          status: "provider-succeeded",
          provider_shipment_id: params?.[1],
          provider_label_id: params?.[2],
          tracking_identifier: params?.[3],
          updated_at: params?.[4],
        };
        return { rows: [] };
      }

      if (sql.includes("SET status = 'succeeded'")) {
        operation = {
          ...operation,
          status: "succeeded",
          provider_shipment_id: params?.[1],
          provider_label_id: params?.[2],
          tracking_identifier: params?.[3],
          completed_at: params?.[4],
          updated_at: params?.[4],
        };
        return { rows: [] };
      }

      if (sql.includes("SET status = 'failed'")) {
        operation = {
          ...operation,
          status: "failed",
          error_message: params?.[1],
          completed_at: params?.[2],
          updated_at: params?.[2],
        };
        return { rows: [] };
      }

      if (sql.includes("ORDER BY updated_at ASC, operation_key ASC")) {
        return operation && ["pending", "provider-succeeded"].includes(String(operation.status))
          ? { rows: [operation] }
          : { rows: [] };
      }

      if (sql.includes("FROM fulfillment_shipment_pages AS page")) {
        return { rows: [shipmentRow] };
      }

      return { rows: [] };
    }),
    readOperation: () => operation,
  };
  return db;
}

describe("fulfillment shipment runtime", () => {
  it("creates a shipment from a ready local order source", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return { rows: [] };
        }

        if (sql.includes("FROM fulfillment_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                shipping_option: "standard",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
                status: "ready-for-fulfillment",
              },
            ],
          };
        }

        if (sql.includes("FROM fulfillment_order_source_lines")) {
          return {
            rows: [
              {
                order_line_id: "oli_1",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                product_summary: null,
                quantity: 1,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await services.createShipmentForReadyOrder({
      orderId: "ord_1",
      readyForFulfillmentAt: "2026-04-02T00:00:00.000Z",
      context: {
        tenantId: "tnt_test" as never,
        audit: {
          performedByUserId: "usr_test" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    });

    const createdEvent = readAllEvents().find((event) => event.eventType === "fulfillment.shipment.created");

    expect(createdEvent?.payload).toMatchObject({
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      shippingOption: "standard",
    });
  });

  it("purchases USPS postage through a sandbox-compatible provider", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        providerShipmentId: "sandbox_shipment_1",
        providerLabelId: "sandbox_label_1",
        providerRateId: "sandbox_rate_1",
        carrierName: "USPS",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        labelReference: "sandbox_label_1",
        labelDocumentUrl: "https://sandbox.test/label.pdf",
        trackingIdentifier: "940000000000000000",
        postageAmountCents: 499,
        postageCurrency: "USD",
        purchasedAt: "2026-04-02T00:10:00.000Z",
      })),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const db = {
      query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
                shipping_plan_snapshot: parcelShippingPlan,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: parcelShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryConfirmation: "signature",
        insuranceAmount: null,
        sender: expect.objectContaining({
          name: "Seller",
          street1: "1 Main St",
          postalCode: "78701",
        }),
        recipient: expect.objectContaining({
          name: "Buyer",
          street1: "2 Market St",
          postalCode: "60601",
        }),
        package: expect.objectContaining({
          mailpieceClass: "parcel",
          lengthInches: 8,
          widthInches: 6,
          heightInches: 2,
          weightOunces: 5.25,
        }),
      }),
    );
    const providerOperationCall = db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO fulfillment_postage_label_operations"),
    );
    expect(providerOperationCall).toBeTruthy();
    const operationRequest = String(providerOperationCall?.[1]?.[6]);
    expect(operationRequest).toContain('"postagePolicySnapshot"');
    expect(operationRequest).toContain('"signatureRequired":true');
    expect(operationRequest).toContain('"insuranceRequired":false');
    expect(operationRequest).toContain('"shippingEvidenceTier":"signature-confirmed"');
    expect(operationRequest).not.toContain("1 Main St");
    expect(operationRequest).not.toContain("2 Market St");
    expect(operationRequest).not.toContain('"sender"');
    expect(operationRequest).not.toContain('"recipient"');
    expect(db.query.mock.invocationCallOrder[db.query.mock.calls.indexOf(providerOperationCall!)]).toBeLessThan(
      vi.mocked(postageLabelProvider.purchaseUspsLabel).mock.invocationCallOrder[0],
    );
    const attachedEvent = readAllEvents().find((event) => event.eventType === "fulfillment.shipment.label-attached");
    expect(attachedEvent?.payload).toMatchObject({
      carrierName: "USPS",
      labelDocumentUrl: "https://sandbox.test/label.pdf",
      trackingIdentifier: "940000000000000000",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
    });
  });

  it("attaches required carrier insurance from the committed shipping-evidence tier", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => purchasedSandboxLabel),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb(createPackedShipmentRow({ shipping_plan_snapshot: insuredShippingPlan }));
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryConfirmation: "signature",
        insuranceAmount: "500.00",
      }),
    );
    expect(db.readOperation()?.request_json).toMatchObject({
      insuranceAmount: "500.00",
      postagePolicySnapshot: {
        insuranceRequired: true,
        insuredValueAmount: "500.00",
        shippingEvidenceTier: "carrier-insured",
      },
    });
  });

  it("keeps concurrent USPS label purchases single-flight for one shipment intent", async () => {
    const { eventStore } = createInMemoryEventStore();
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerStartedSignal = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerReleaseSignal = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => {
        providerStarted();
        await providerReleaseSignal;
        return purchasedSandboxLabel;
      }),
      recoverPurchasedUspsLabel: vi.fn(),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb();
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);

    const firstPurchase = services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );
    await providerStartedSignal;

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
        },
        context,
      ),
    ).rejects.toThrow("Postage label purchase is already in progress");

    releaseProvider();
    await firstPurchase;

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "shipment:shp_1:purchase-usps-label:initial",
      }),
    );
  });

  it("reconciles provider-success/local-append failure and replays seller retries without buying again", async () => {
    const store = createInMemoryEventStore();
    let failNextAttachAppend = true;
    const eventStore: EventStore = {
      ...store.eventStore,
      appendToStream: async (input) => {
        if (
          failNextAttachAppend &&
          input.events.some((event) => event.eventType === "fulfillment.shipment.label-attached")
        ) {
          failNextAttachAppend = false;
          throw new Error("simulated append failure");
        }
        return store.eventStore.appendToStream(input);
      },
    };
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => purchasedSandboxLabel),
      recoverPurchasedUspsLabel: vi.fn(async () => purchasedSandboxLabel),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb();
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
        },
        context,
      ),
    ).rejects.toThrow("simulated append failure");
    expect(db.readOperation()).toMatchObject({
      status: "provider-succeeded",
      provider_label_id: "sandbox_label_1",
      tracking_identifier: "940000000000000000",
    });

    await expect(
      services.reconcileStalePostageLabelPurchases({
        staleBefore: "2026-04-02T00:20:00.000Z",
      }),
    ).resolves.toMatchObject({ checked: 1, attached: 1, failed: 0 });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(postageLabelProvider.recoverPurchasedUspsLabel).toHaveBeenCalledTimes(1);
    expect(
      store.readAllEvents().filter((event) => event.eventType === "fulfillment.shipment.label-attached"),
    ).toHaveLength(1);
  });

  it("marks stale pending label purchases failed when EasyPost has no purchased shipment to recover", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => {
        throw new Error("provider buy should not run during stale reconciliation");
      }),
      recoverPurchasedUspsLabel: vi.fn(async () => null),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb();
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    await seedPackedShipmentAggregate(services, {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    });
    await recordFulfillmentPostageLabelOperationPending(db as never, {
      operationKey: "shipment:shp_1:purchase-usps-label:initial",
      operationKind: "purchase-usps-label",
      shipmentId: "shp_1",
      providerName: "sandbox-usps",
      providerMode: "test",
      idempotencyKey: "shipment:shp_1:purchase-usps-label:initial",
      request: {},
      createdAt: "2026-04-02T00:00:00.000Z",
    });

    await expect(
      services.reconcileStalePostageLabelPurchases({
        staleBefore: "2026-04-02T00:20:00.000Z",
      }),
    ).resolves.toMatchObject({ checked: 1, attached: 0, failed: 1 });

    expect(db.readOperation()).toMatchObject({
      status: "failed",
      error_message: "No purchased provider label was found for the stale postage label purchase operation.",
    });
    expect(postageLabelProvider.purchaseUspsLabel).not.toHaveBeenCalled();
  });

  it("marks stale provider-submitted label voids failed for operator review", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb();
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    await recordFulfillmentPostageLabelOperationPending(db as never, {
      operationKey: "shipment:shp_1:void-label:2026-04-02T00:15:00.000Z",
      operationKind: "void-label",
      shipmentId: "shp_1",
      providerName: "sandbox-usps",
      providerMode: "test",
      idempotencyKey: "shipment:shp_1:void-label:2026-04-02T00:15:00.000Z",
      request: {
        providerShipmentId: "sandbox_shipment_1",
        providerLabelId: "sandbox_label_1",
        trackingIdentifier: "940000000000000000",
      },
      createdAt: "2026-04-02T00:15:00.000Z",
    });

    await expect(
      services.reconcileStalePostageLabelVoids({
        staleBefore: "2026-04-03T00:20:00.000Z",
      }),
    ).resolves.toMatchObject({ checked: 1, failed: 1 });

    expect(db.readOperation()).toMatchObject({
      status: "failed",
      error_message: "Postage label void request is stale without a terminal provider refund status.",
    });
  });

  it("rejects parcel-required shipments when a label override attempts Letter Mail", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(),
      voidLabel: vi.fn(),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
                shipping_plan_snapshot: parcelShippingPlan,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: parcelShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "First",
          package: {
            mailpieceClass: "letter",
            lengthInches: 9.5,
            widthInches: 4.125,
            heightInches: 0.25,
            weightOunces: 1,
          },
        },
        context,
      ),
    ).rejects.toThrow("Parcel postage is required by the committed postage policy snapshot for this shipment.");
    expect(postageLabelProvider.purchaseUspsLabel).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO fulfillment_postage_label_operations"),
      expect.anything(),
    );
    const failedEvent = readAllEvents().find(
      (event) => event.eventType === "fulfillment.shipment.label-purchase-failed",
    );
    expect(failedEvent?.payload).toMatchObject({
      errorCode: "postage_policy_validation_failed",
      errorMessage: "Parcel postage is required by the committed postage policy snapshot for this shipment.",
    });
  });

  it("keeps ambiguous provider purchase failures pending so retries cannot buy another label", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => {
        throw new Error("network lost after provider request");
      }),
      recoverPurchasedUspsLabel: vi.fn(async () => null),
      voidLabel: vi.fn(),
    };
    const db = createPostageOperationDb();
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
        },
        context,
      ),
    ).rejects.toThrow("network lost after provider request");
    expect(db.readOperation()).toMatchObject({
      status: "pending",
      operation_key: "shipment:shp_1:purchase-usps-label:initial",
    });

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
        },
        context,
      ),
    ).rejects.toThrow("Postage label purchase is already in progress");

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    await expect(
      services.reconcileStalePostageLabelPurchases({
        staleBefore: "2026-04-02T00:20:00.000Z",
      }),
    ).resolves.toMatchObject({ checked: 1, failed: 1 });
    expect(db.readOperation()).toMatchObject({
      status: "failed",
      error_message: "No purchased provider label was found for the stale postage label purchase operation.",
    });
  });

  it("records provider capability failures with a distinct label error code", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => {
        throw new PostageLabelProviderError({
          kind: "capability",
          capability: "signature-delivery-confirmation",
          message: "Signature delivery confirmation is unavailable.",
          providerName: "sandbox-usps",
          providerMode: "test",
        });
      }),
      voidLabel: vi.fn(),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
                shipping_plan_snapshot: parcelShippingPlan,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: parcelShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
        },
        context,
      ),
    ).rejects.toThrow("Signature delivery confirmation is unavailable.");

    const failedEvent = readAllEvents().find(
      (event) => event.eventType === "fulfillment.shipment.label-purchase-failed",
    );
    expect(failedEvent?.payload).toMatchObject({
      errorCode: "postage_provider_capability_failure",
      errorMessage: "Signature delivery confirmation is unavailable.",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
    });
  });

  it("uses the original shipping plan snapshot when a voided label is re-bought", async () => {
    const { eventStore } = createInMemoryEventStore();
    let purchaseCount = 0;
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => {
        purchaseCount += 1;
        return {
          providerName: "sandbox-usps",
          providerMode: "test" as const,
          providerShipmentId: `sandbox_shipment_${purchaseCount}`,
          providerLabelId: `sandbox_label_${purchaseCount}`,
          providerRateId: "sandbox_rate_1",
          carrierName: "USPS",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
          labelReference: `sandbox_label_${purchaseCount}`,
          labelDocumentUrl: "https://sandbox.test/label.pdf",
          trackingIdentifier: "940000000000000000",
          postageAmountCents: 499,
          postageCurrency: "USD",
          purchasedAt: "2026-04-02T00:10:00.000Z",
        };
      }),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const awaitingLabelRow = {
      shipment_id: "shp_1",
      order_id: "ord_1",
      seller_account_id: "acc_seller",
      status: "awaiting-label",
      package_status: "packed",
      shipping_destination_snapshot: shippingDestinationSnapshot,
      shipping_origin_snapshot: shippingOriginSnapshot,
      shipping_plan_snapshot: parcelShippingPlan,
    };
    const labelAttachedRow = {
      ...awaitingLabelRow,
      status: "label-attached",
      postage_provider_shipment_id: "sandbox_shipment_1",
      postage_provider_label_id: "sandbox_label_1",
      tracking_identifier: "940000000000000000",
    };
    const shipmentRows = [awaitingLabelRow, labelAttachedRow, awaitingLabelRow, awaitingLabelRow];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return { rows: [shipmentRows.shift() ?? awaitingLabelRow] };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: parcelShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );
    await services.voidLabel({ shipmentId: "shp_1", sellerAccountId: "acc_seller" }, context);
    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "First",
          package: {
            mailpieceClass: "letter",
            lengthInches: 9.5,
            widthInches: 4.125,
            heightInches: 0.25,
            weightOunces: 1,
          },
        },
        context,
      ),
    ).rejects.toThrow("Parcel postage is required by the committed postage policy snapshot for this shipment.");
    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledTimes(1);

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
      },
      context,
    );

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledTimes(2);
    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryConfirmation: "signature",
        package: expect.objectContaining({
          mailpieceClass: "parcel",
          weightOunces: 5.25,
        }),
      }),
    );
  });

  it("validates the aggregate before submitting provider label voids", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              createPackedShipmentRow({
                status: "label-attached",
                label_status: "purchased",
                tracking_identifier: "940000000000000000",
                postage_provider_shipment_id: "sandbox_shipment_1",
                postage_provider_label_id: "sandbox_label_1",
              }),
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "sandbox_label_1",
        trackingIdentifier: "940000000000000000",
        postageProviderShipmentId: "sandbox_shipment_1",
        postageProviderLabelId: "sandbox_label_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-04-02T00:10:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "DispatchShipment",
        dispatchedAt: "2026-04-02T00:12:00.000Z",
      },
      context,
    });

    await expect(services.voidLabel({ shipmentId: "shp_1", sellerAccountId: "acc_seller" }, context)).rejects.toThrow(
      "Only attached labels can be voided before dispatch.",
    );

    expect(postageLabelProvider.voidLabel).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO fulfillment_postage_label_operations"),
      expect.anything(),
    );
  });

  it("purchases Letter Mail postage from the committed package plan weight", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        providerShipmentId: "sandbox_letter_shipment_1",
        providerLabelId: "sandbox_letter_label_1",
        providerRateId: "sandbox_letter_rate_1",
        carrierName: "USPS",
        serviceLevel: "First",
        labelReference: "sandbox_letter_label_1",
        labelDocumentUrl: "https://sandbox.test/letter-label.pdf",
        trackingIdentifier: "940000000000000001",
        postageAmountCents: 73,
        postageCurrency: "USD",
        purchasedAt: "2026-04-02T00:10:00.000Z",
      })),
      voidLabel: vi.fn(),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_letter_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
                shipping_plan_snapshot: letterShippingPlan,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_letter_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_letter_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: letterShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_letter_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_letter_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_letter_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_letter_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "First",
      },
      context,
    );

    expect(postageLabelProvider.purchaseUspsLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceLevel: "First",
        deliveryConfirmation: null,
        insuranceAmount: null,
        labelSize: "7x3",
        package: {
          mailpieceClass: "letter",
          lengthInches: 9.5,
          widthInches: 4.125,
          heightInches: 0.25,
          weightOunces: 0.47,
        },
      }),
    );
  });

  it("rejects label address overrides without an override reason", async () => {
    const { eventStore } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });

    await expect(
      services.purchaseUspsLabel(
        {
          shipmentId: "shp_1",
          sellerAccountId: "acc_seller",
          serviceLevel: "USPS_GROUND_ADVANTAGE",
          sender: {
            name: "Seller",
            street1: "9 Override St",
            city: "Austin",
            state: "TX",
            postalCode: "78701",
            country: "US",
          },
          package: {
            lengthInches: 7,
            widthInches: 5,
            heightInches: 1,
            weightOunces: 4,
          },
        },
        {
          tenantId: "tnt_test" as never,
          audit: {
            performedByUserId: "usr_test" as never,
            forAccountId: "acc_seller" as never,
          },
        },
      ),
    ).rejects.toThrow("Address override reason is required when label addresses differ from shipment snapshots.");
    expect(postageLabelProvider.purchaseUspsLabel).not.toHaveBeenCalled();
  });

  it("records audit metadata when label address overrides include a reason", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      purchaseUspsLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        providerShipmentId: "sandbox_shipment_1",
        providerLabelId: "sandbox_label_1",
        providerRateId: "sandbox_rate_1",
        carrierName: "USPS",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        labelReference: "sandbox_label_1",
        labelDocumentUrl: "https://sandbox.test/label.pdf",
        trackingIdentifier: "940000000000000000",
        postageAmountCents: 499,
        postageCurrency: "USD",
        purchasedAt: "2026-04-02T00:10:00.000Z",
      })),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test" as const,
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
                shipping_destination_snapshot: shippingDestinationSnapshot,
                shipping_origin_snapshot: shippingOriginSnapshot,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-04-02T00:04:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        recipient: {
          name: "Buyer",
          street1: "22 Market St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        overrideReason: "Buyer confirmed apartment correction.",
        package: {
          lengthInches: 7,
          widthInches: 5,
          heightInches: 1,
          weightOunces: 4,
        },
      },
      context,
    );

    const attachedEvent = readAllEvents().find((event) => event.eventType === "fulfillment.shipment.label-attached");
    expect(attachedEvent?.payload).toMatchObject({
      addressOverrideAudit: {
        changedSide: "recipient",
        reason: "Buyer confirmed apartment correction.",
        actor: "usr_test",
        originalRecipientSnapshot: shippingDestinationSnapshot,
        submittedRecipientAddress: expect.objectContaining({
          line1: "22 Market St",
        }),
      },
    });
  });

  it("records EasyPost tracking webhooks and advances labeled shipments to delivered", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageWebhookGateway: PostageProviderWebhookGateway = {
      processPostageProviderWebhook: vi.fn(async () => ({
        providerEventId: "evt_tracker_1",
        providerName: "easypost",
        providerMode: "production" as const,
        eventKind: "tracking-status" as const,
        providerObjectReference: "trk_provider_1",
        providerShipmentId: "shp_provider_1",
        trackingIdentifier: "940000000000000000",
        status: "delivered",
        statusDetail: "arrived_at_destination",
        occurredAt: "2026-05-30T12:00:01.000Z",
        receivedAt: "2026-05-30T12:00:03.000Z",
        payload: { id: "evt_tracker_1" },
      })),
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        const receipt = webhookReceiptQueryResult(sql, values);
        if (receipt) return receipt;
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                tenant_id: "tnt_test",
                seller_account_id: "acc_seller",
                status: "label-attached",
                tracking_identifier: "940000000000000000",
                postage_provider_shipment_id: "shp_provider_1",
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageWebhookGateway,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot,
        shippingOriginSnapshot,
        shippingPlanSnapshot: parcelShippingPlan,
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-05-30T11:45:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "StartShipmentPacking",
        startedAt: "2026-05-30T11:48:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "ConfirmShipmentPackingLine",
        lineId: "spl_1" as never,
        confirmedAt: "2026-05-30T11:49:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-05-30T11:50:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "pl_1",
        labelDocumentUrl: "https://labels.easypost.test/pl_1.pdf",
        trackingIdentifier: "940000000000000000",
        postageProviderName: "easypost",
        postageProviderMode: "production",
        postageProviderShipmentId: "shp_provider_1",
        postageProviderLabelId: "pl_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-05-30T11:55:00.000Z",
      },
      context,
    });

    await expect(
      services.processPostageProviderWebhook(
        {
          rawBody: "{}",
          method: "POST",
          path: "/api/fulfillment/provider/postage/webhooks",
          headers: new Headers(),
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: "recorded",
      providerEventId: "evt_tracker_1",
      shipmentId: "shp_1",
      processingResult: "delivered",
    });

    expect(readAllEvents().map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["fulfillment.shipment.dispatched", "fulfillment.shipment.delivered"]),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO fulfillment_postage_provider_events"),
      expect.arrayContaining(["evt_tracker_1", "easypost", "production", "tracking-status", "delivered"]),
    );
  });

  it("applies refunded EasyPost refund webhooks to requested label voids", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageWebhookGateway: PostageProviderWebhookGateway = {
      processPostageProviderWebhook: vi.fn(async () => ({
        providerEventId: "evt_refund_1",
        providerName: "easypost",
        providerMode: "production" as const,
        eventKind: "refund-status" as const,
        providerObjectReference: "rfnd_provider_1",
        providerShipmentId: "shp_provider_1",
        trackingIdentifier: "940000000000000000",
        status: "refunded",
        occurredAt: "2026-05-30T12:00:02.000Z",
        receivedAt: "2026-05-30T12:00:04.000Z",
        payload: { id: "evt_refund_1" },
      })),
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        const receipt = webhookReceiptQueryResult(sql, values);
        if (receipt) return receipt;
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                tenant_id: "tnt_test",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                label_status: "void-requested",
                label_refund_status: "submitted",
                label_voided_at: "2026-05-30T11:58:00.000Z",
                tracking_identifier: "940000000000000000",
                postage_provider_shipment_id: "shp_provider_1",
                matched_void_operation_key: "shipment:shp_1:void-label:2026-05-30T11:58:00.000Z",
                matched_void_operation_status: "provider-succeeded",
              },
            ],
          };
        }
        if (sql.includes("SET status = 'succeeded'")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageWebhookGateway,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "pl_1",
        labelDocumentUrl: "https://labels.easypost.test/pl_1.pdf",
        trackingIdentifier: "940000000000000000",
        postageProviderName: "easypost",
        postageProviderMode: "production",
        postageProviderShipmentId: "shp_provider_1",
        postageProviderLabelId: "pl_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-05-30T11:55:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "VoidShipmentLabel",
        refundStatus: "submitted",
        refundReference: "rfnd_provider_1",
        voidedAt: "2026-05-30T11:58:00.000Z",
      },
      context,
    });

    await expect(
      services.processPostageProviderWebhook(
        {
          rawBody: "{}",
          method: "POST",
          path: "/api/fulfillment/provider/postage/webhooks",
          headers: new Headers(),
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: "recorded",
      providerEventId: "evt_refund_1",
      eventKind: "refund-status",
      shipmentId: "shp_1",
      processingResult: "refund-refunded",
    });

    expect(readAllEvents().map((event) => event.eventType)).toContain(
      "fulfillment.shipment.label-refund-status-recorded",
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO fulfillment_postage_provider_events"),
      expect.arrayContaining([
        "evt_refund_1",
        "easypost",
        "production",
        "refund-status",
        "rfnd_provider_1",
        "shp_1",
        "940000000000000000",
        "refunded",
        "refund-refunded",
      ]),
    );
  });

  it("applies rejected refund webhooks to requested label voids", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageWebhookGateway: PostageProviderWebhookGateway = {
      processPostageProviderWebhook: vi.fn(async () => ({
        providerEventId: "evt_refund_rejected_1",
        providerName: "easypost",
        providerMode: "production" as const,
        eventKind: "refund-status" as const,
        providerObjectReference: "rfnd_provider_1",
        providerShipmentId: "shp_provider_1",
        trackingIdentifier: "940000000000000000",
        status: "rejected",
        occurredAt: "2026-05-30T12:00:02.000Z",
        receivedAt: "2026-05-30T12:00:04.000Z",
        payload: { id: "evt_refund_rejected_1" },
      })),
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        const receipt = webhookReceiptQueryResult(sql, values);
        if (receipt) return receipt;
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                tenant_id: "tnt_test",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                label_status: "void-requested",
                label_refund_status: "submitted",
                label_voided_at: "2026-05-30T11:58:00.000Z",
                tracking_identifier: "940000000000000000",
                postage_provider_shipment_id: "shp_provider_1",
                matched_void_operation_key: "shipment:shp_1:void-label:2026-05-30T11:58:00.000Z",
                matched_void_operation_status: "provider-succeeded",
              },
            ],
          };
        }
        if (sql.includes("SET status = 'failed'")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageWebhookGateway,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "pl_1",
        labelDocumentUrl: "https://labels.easypost.test/pl_1.pdf",
        trackingIdentifier: "940000000000000000",
        postageProviderName: "easypost",
        postageProviderMode: "production",
        postageProviderShipmentId: "shp_provider_1",
        postageProviderLabelId: "pl_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-05-30T11:55:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "VoidShipmentLabel",
        refundStatus: "submitted",
        refundReference: "rfnd_provider_1",
        voidedAt: "2026-05-30T11:58:00.000Z",
      },
      context,
    });

    await expect(
      services.processPostageProviderWebhook(
        {
          rawBody: "{}",
          method: "POST",
          path: "/api/fulfillment/provider/postage/webhooks",
          headers: new Headers(),
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: "recorded",
      providerEventId: "evt_refund_rejected_1",
      eventKind: "refund-status",
      shipmentId: "shp_1",
      processingResult: "refund-rejected",
    });

    const refundEvent = readAllEvents().find(
      (event) => event.eventType === "fulfillment.shipment.label-refund-status-recorded",
    );
    expect(refundEvent?.payload).toMatchObject({
      refundStatus: "rejected",
      refundReference: "rfnd_provider_1",
    });
  });

  it("surfaces rejected refund webhooks after a replacement label without mutating the new label", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageWebhookGateway: PostageProviderWebhookGateway = {
      processPostageProviderWebhook: vi.fn(async () => ({
        providerEventId: "evt_refund_after_rebuy_1",
        providerName: "easypost",
        providerMode: "production" as const,
        eventKind: "refund-status" as const,
        providerObjectReference: "rfnd_provider_1",
        providerShipmentId: "old_provider_shipment_1",
        trackingIdentifier: "940000000000000000",
        status: "rejected",
        occurredAt: "2026-05-30T12:10:00.000Z",
        receivedAt: "2026-05-30T12:10:04.000Z",
        payload: { id: "evt_refund_after_rebuy_1" },
      })),
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        const receipt = webhookReceiptQueryResult(sql, values);
        if (receipt) return receipt;
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                tenant_id: "tnt_test",
                seller_account_id: "acc_seller",
                status: "label-attached",
                label_status: "purchased",
                label_refund_status: null,
                label_voided_at: null,
                tracking_identifier: "940000000000000001",
                postage_provider_shipment_id: "new_provider_shipment_1",
                matched_void_operation_key: "shipment:shp_1:void-label:2026-05-30T11:58:00.000Z",
                matched_void_operation_status: "provider-succeeded",
              },
            ],
          };
        }
        if (sql.includes("SET status = 'failed'")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postageWebhookGateway,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };
    await seedPackedShipmentAggregate(services, context);
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "old_pl_1",
        trackingIdentifier: "940000000000000000",
        postageProviderShipmentId: "old_provider_shipment_1",
        postageProviderLabelId: "old_pl_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-05-30T11:55:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "VoidShipmentLabel",
        refundStatus: "submitted",
        refundReference: "rfnd_provider_1",
        voidedAt: "2026-05-30T11:58:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "new_pl_1",
        trackingIdentifier: "940000000000000001",
        postageProviderShipmentId: "new_provider_shipment_1",
        postageProviderLabelId: "new_pl_1",
        postageAmountCents: 499,
        postageCurrency: "USD",
        attachedAt: "2026-05-30T12:05:00.000Z",
      },
      context,
    });
    const eventCountBeforeWebhook = readAllEvents().length;

    await expect(
      services.processPostageProviderWebhook(
        {
          rawBody: "{}",
          method: "POST",
          path: "/api/fulfillment/provider/postage/webhooks",
          headers: new Headers(),
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: "recorded",
      providerEventId: "evt_refund_after_rebuy_1",
      eventKind: "refund-status",
      shipmentId: "shp_1",
      processingResult: "refund-rejected-after-rebuy",
    });

    expect(readAllEvents()).toHaveLength(eventCountBeforeWebhook);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE fulfillment_postage_label_operations"),
      expect.arrayContaining([
        "shipment:shp_1:void-label:2026-05-30T11:58:00.000Z",
        "Postage label refund was rejected after a replacement label was purchased.",
      ]),
    );
  });

  it("blocks dispatch while a Stripe Radar review hold is open for the order", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              createPackedShipmentRow({
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "label-attached",
                label_status: "purchased",
              }),
            ],
          };
        }
        if (sql.includes("FROM fulfillment_payment_fraud_review_holds")) {
          return { rows: [{ provider_review_id: "prv_123" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await expect(
      services.dispatchShipment(
        {
          shipmentId: "shp_1" as never,
          sellerAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).rejects.toThrow("Shipment dispatch is blocked while Stripe reviews the payment.");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_payment_fraud_review_holds"), ["ord_1"]);
  });
});
