import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  PostageLabelProviderError,
  type PostageLabelProvider,
  type PurchasedPostageLabel,
} from "@chase-sets/postage-labels";
import { createReturnFacilityDirectory, type ReturnFacilityDirectory } from "../domain/facility-directory";
import { createReturnShipmentLabelPurchaseService, type ReturnLabelDirective } from "./label-purchase";
import type { ReturnShipmentLinkageSource } from "../read-model/linkage";

const context: EventStoreContext = {
  tenantId: "tnt_fulfillment" as never,
  audit: { performedByUserId: "usr_ops" as never, forAccountId: "acc_ops" as never },
};

function directoryWith(
  overrides: Partial<Parameters<typeof createReturnFacilityDirectory>[0][number]> = {},
): ReturnFacilityDirectory {
  return createReturnFacilityDirectory([
    {
      facilityId: "fac_east",
      configVersion: "v1",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      supportedReturnPrograms: ["platform-custody"],
      supportedCarriers: ["usps"],
      supportedRegions: ["us-east"],
      packageConstraints: { maxWeightOunces: 80, maxLengthInches: 24, maxWidthInches: 18, maxHeightInches: 12 },
      postalAddress: {
        name: "Returns East",
        line1: "100 Dock St",
        city: "Newark",
        state: "NJ",
        postalCode: "07102",
        country: "US",
      },
      restrictedRouting: { operationalContact: "ops@internal", internalRoutingCode: "EAST-42" },
      displayName: "Chase Sets Returns (East)",
      displayInstructions: "Include the packing slip.",
      ...overrides,
    },
  ]);
}

function directive(overrides: Partial<ReturnLabelDirective> = {}): ReturnLabelDirective {
  return {
    returnShipmentId: "rsh_1" as never,
    remedyId: "rmd_1" as never,
    supportRequestId: "sup_1" as never,
    orderId: "ord_1" as never,
    outboundShipmentId: "shp_1" as never,
    affectedOrderLineIds: ["oli_1"],
    returnProgram: "platform-custody",
    carrier: "usps",
    region: "us-east",
    serviceLevel: "usps_ground_advantage",
    shipFromSnapshot: {
      name: "Buyer",
      line1: "2 Market St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    packageRequirements: { weightOunces: 10, lengthInches: 9, widthInches: 6, heightInches: 2 },
    costPayer: "platform",
    costAllocationReference: "cov_1",
    estimatedPostageAmountCents: 450,
    selectionPolicyVersion: "facility-selection-v1",
    shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
    returnByDeadlineAt: "2026-06-20T00:00:00.000Z",
    policyVersion: "return-policy-v1",
    idempotencyKey: "authz-1",
    ...overrides,
  };
}

/** In-memory stand-in for the return-label operation ledger, keyed by operation_key. */
function createLedgerDb() {
  const ops = new Map<string, Record<string, unknown>>();
  const db = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      const p = params ?? [];
      if (sql.includes("WITH reserved_operation")) {
        const key = String(p[0]);
        const existing = ops.get(key);
        if (!existing || existing.status === "failed") {
          const row = {
            operation_key: p[0],
            operation_kind: p[1],
            return_shipment_id: p[2],
            remedy_id: p[3],
            provider_name: p[4],
            provider_mode: p[5],
            idempotency_key: p[6],
            request_json: JSON.parse(String(p[7] ?? "{}")),
            status: "pending",
            provider_shipment_id: null,
            provider_label_id: null,
            tracking_identifier: null,
            error_message: null,
            created_at: p[8],
            updated_at: p[8],
            completed_at: null,
          };
          ops.set(key, row);
          return { rows: [{ ...row, operation_reserved: true }] };
        }
        return { rows: [{ ...existing, operation_reserved: false }] };
      }
      if (sql.includes("SET status = 'provider-succeeded'")) {
        const op = ops.get(String(p[0]));
        if (op) {
          op.status = "provider-succeeded";
          op.provider_shipment_id = p[1];
          op.provider_label_id = p[2];
          op.tracking_identifier = p[3];
          op.updated_at = p[4];
        }
        return { rows: [] };
      }
      if (sql.includes("SET status = 'succeeded'")) {
        const op = ops.get(String(p[0]));
        if (op) {
          op.status = "succeeded";
          op.provider_shipment_id = p[1];
          op.provider_label_id = p[2];
          op.tracking_identifier = p[3];
          op.completed_at = p[4];
          op.updated_at = p[4];
        }
        return { rows: [] };
      }
      if (sql.includes("SET status = 'failed'")) {
        const op = ops.get(String(p[0]));
        if (op) {
          op.status = "failed";
          op.error_message = p[1];
          op.completed_at = p[2];
          op.updated_at = p[2];
        }
        return { rows: [] };
      }
      if (sql.includes("FROM fulfillment_return_shipment_label_operations")) {
        const kind = p[2];
        const rows = [...ops.values()].filter(
          (o) => ["pending", "provider-succeeded"].includes(String(o.status)) && (!kind || o.operation_kind === kind),
        );
        return { rows };
      }
      return { rows: [] };
    }),
    peek: (key: string) => ops.get(key),
  };
  return db;
}

function purchasedLabel(idempotencyKey: string): PurchasedPostageLabel {
  const suffix = idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "TEST";
  return {
    providerName: "sandbox-usps",
    providerMode: "test",
    providerShipmentId: `ps_${suffix}`,
    providerLabelId: `pl_${suffix}`,
    providerRateId: `rate_${suffix}`,
    carrierName: "USPS",
    serviceLevel: "usps_ground_advantage",
    labelReference: `lbl_${suffix}`,
    labelDocumentUrl: `https://sandbox.test/return-labels/${suffix}.pdf`,
    trackingIdentifier: `9400${suffix.padStart(18, "0").slice(0, 18)}`,
    postageAmountCents: 499,
    postageCurrency: "USD",
    purchasedAt: "2026-06-02T00:00:00.000Z",
  };
}

function createRecordingProvider(overrides: Partial<PostageLabelProvider> = {}): PostageLabelProvider {
  return {
    providerName: "sandbox-usps",
    providerMode: "test",
    purchaseUspsLabel: vi.fn(async (request) => purchasedLabel(request.idempotencyKey)),
    voidLabel: vi.fn(async () => ({
      providerName: "sandbox-usps",
      providerMode: "test" as const,
      refundReference: "refund_1",
      refundStatus: "submitted",
      voidedAt: "2026-06-02T12:00:00.000Z",
    })),
    ...overrides,
  };
}

function buildService(
  deps: {
    provider?: PostageLabelProvider;
    directory?: ReturnFacilityDirectory;
    linkageSource?: ReturnShipmentLinkageSource;
  } = {},
) {
  const { eventStore, readAllEvents } = createInMemoryEventStore();
  const db = createLedgerDb();
  const provider = deps.provider ?? createRecordingProvider();
  const loadLinkageSource = vi.fn(
    async () =>
      deps.linkageSource ?? {
        supportOrderId: "ord_1",
        supportAffectedOrderLineIds: ["oli_1"],
        remedySupportRequestId: "sup_1",
        remedyReturnDirective: "return-to-platform",
        shipmentOrderId: "ord_1",
        shipmentOrderLineIds: ["oli_1"],
      },
  );
  const service = createReturnShipmentLabelPurchaseService({
    eventStore,
    db: db as never,
    postageLabelProvider: provider,
    facilityDirectory: deps.directory ?? directoryWith(),
    loadLinkageSource,
    now: () => "2026-06-02T00:00:00.000Z",
  });
  return { service, db, provider, loadLinkageSource, readAllEvents };
}

function eventTypes(readAllEvents: () => readonly { eventType: string }[]) {
  return readAllEvents().map((event) => event.eventType);
}

describe("return-shipment label purchase", () => {
  it("creates one shipment routed to the facility snapshot and a customer-safe label with recorded cost", async () => {
    const { service, provider, readAllEvents } = buildService();
    const result = await service.issueReturnLabel(directive(), context);

    expect(result.outcome).toBe("label-ready");
    if (result.outcome !== "label-ready") throw new Error("expected label-ready");
    expect(result.labelDocumentUrl).toContain("return-labels");
    expect(result.postageAmountCents).toBe(499);
    expect(provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);

    const events = readAllEvents();
    const requested = events.find((e) => e.eventType === "fulfillment.return-shipment.requested.v2");
    const ready = events.find((e) => e.eventType === "fulfillment.return-shipment.label-ready.v1");
    expect((requested?.payload as { destinationSnapshot: { facilityId: string } }).destinationSnapshot.facilityId).toBe(
      "fac_east",
    );
    // Fulfillment records the declared cost payer; it never charges a seller for platform postage.
    expect((requested?.payload as { costPayer: string }).costPayer).toBe("platform");
    expect((ready?.payload as { postageAmountCents: number }).postageAmountCents).toBe(499);
    expect((ready?.payload as { estimatedPostageAmountCents: number }).estimatedPostageAmountCents).toBe(450);
    expect((ready?.payload as { postageProviderLabelId: string }).postageProviderLabelId).toContain("pl_");

    // The label routes buyer -> facility.
    const call = (provider.purchaseUspsLabel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.sender.city).toBe("Chicago");
    expect(call.recipient.city).toBe("Newark");
  });

  it("routes an ordinary support return back to the immutable seller origin without facility selection", async () => {
    const { service, provider, readAllEvents } = buildService({
      directory: createReturnFacilityDirectory([]),
      linkageSource: {
        supportOrderId: "ord_1",
        supportAffectedOrderLineIds: ["oli_1"],
        remedySupportRequestId: "sup_1",
        remedyReturnDirective: "return-to-seller",
        shipmentOrderId: "ord_1",
        shipmentOrderLineIds: ["oli_1"],
      },
    });
    const result = await service.issueReturnLabel(
      directive({
        returnDirective: "return-to-seller",
        destinationSnapshot: {
          destinationType: "seller",
          sellerAccountId: "acc_seller",
          snapshotVersion: "outbound-shipment-origin-v1",
          displayName: "Seller return",
          displayInstructions: "Use the provided label and keep the carrier receipt until the return is complete.",
          postalAddress: {
            name: "Seller",
            line1: "8 Seller St",
            city: "Madison",
            state: "WI",
            postalCode: "53703",
            country: "US",
          },
          region: "us",
          selectedAt: "2026-06-02T00:00:00.000Z",
        },
        costPayer: "seller",
      }),
      context,
    );

    expect(result.outcome).toBe("label-ready");
    const requested = readAllEvents().find((entry) => entry.eventType === "fulfillment.return-shipment.requested.v2");
    expect(requested?.payload).toMatchObject({
      returnDirective: "return-to-seller",
      costPayer: "seller",
      destinationSnapshot: { destinationType: "seller", sellerAccountId: "acc_seller" },
    });
    const call = (provider.purchaseUspsLabel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.recipient.city).toBe("Madison");
  });

  it("is idempotent under retries: a second directive buys no second label", async () => {
    const { service, provider, loadLinkageSource, readAllEvents } = buildService();
    const first = await service.issueReturnLabel(directive(), context);
    const second = await service.issueReturnLabel(directive(), context);

    expect(first.outcome).toBe("label-ready");
    expect(second.outcome).toBe("label-ready");
    expect(provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(loadLinkageSource).toHaveBeenCalledTimes(1);
    const readyCount = eventTypes(readAllEvents).filter(
      (t) => t === "fulfillment.return-shipment.label-ready.v1",
    ).length;
    expect(readyCount).toBe(1);
  });

  it("rejects reusing a return-shipment identity across support cases from immutable state", async () => {
    const { service, provider, loadLinkageSource } = buildService();
    await service.issueReturnLabel(directive(), context);

    const conflicting = await service.issueReturnLabel(directive({ supportRequestId: "sup_other" as never }), context);

    expect(conflicting).toMatchObject({ outcome: "failed", failureReason: "invalid-return-linkage" });
    expect(provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(loadLinkageSource).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["support case/order", { supportOrderId: "ord_other" }],
    ["remedy/case", { remedySupportRequestId: "sup_other" }],
    ["outbound shipment/order", { shipmentOrderId: "ord_other" }],
    ["affected line/shipment", { shipmentOrderLineIds: ["oli_other"] }],
  ])("rejects invalid %s linkage before buying a label", async (_label, mismatch) => {
    const { service, provider, readAllEvents } = buildService({
      linkageSource: {
        supportOrderId: "ord_1",
        supportAffectedOrderLineIds: ["oli_1"],
        remedySupportRequestId: "sup_1",
        remedyReturnDirective: "return-to-platform",
        shipmentOrderId: "ord_1",
        shipmentOrderLineIds: ["oli_1"],
        ...mismatch,
      },
    });

    const result = await service.issueReturnLabel(directive(), context);

    expect(result).toMatchObject({ outcome: "failed", failureReason: "invalid-return-linkage" });
    expect(provider.purchaseUspsLabel).not.toHaveBeenCalled();
    expect(readAllEvents()).toHaveLength(0);
  });

  it("does not buy a second label when the provider times out after success", async () => {
    let attempted = 0;
    const provider = createRecordingProvider({
      purchaseUspsLabel: vi.fn(async () => {
        attempted += 1;
        throw new PostageLabelProviderError({ kind: "provider", message: "gateway timeout" });
      }),
      recoverPurchasedUspsLabel: vi.fn(async (request) => purchasedLabel(request.idempotencyKey)),
    });
    const { service, readAllEvents } = buildService({ provider });
    const result = await service.issueReturnLabel(directive(), context);

    expect(result.outcome).toBe("label-ready");
    expect(attempted).toBe(1);
    expect(provider.recoverPurchasedUspsLabel).toHaveBeenCalledTimes(1);
    const readyCount = eventTypes(readAllEvents).filter(
      (t) => t === "fulfillment.return-shipment.label-ready.v1",
    ).length;
    expect(readyCount).toBe(1);
  });

  it("fails with no-eligible-facility when the region has no facility", async () => {
    const { service, readAllEvents } = buildService({ directory: directoryWith({ supportedRegions: ["us-west"] }) });
    const result = await service.issueReturnLabel(directive(), context);
    expect(result).toMatchObject({ outcome: "failed", failureReason: "no-eligible-facility", returnShipmentId: null });
    // Nothing was created, so there is no reverse-shipment stream to leak.
    expect(eventTypes(readAllEvents)).toHaveLength(0);
  });

  it("fails with unsupported-parcel when the route matches but the parcel is too large", async () => {
    const { service } = buildService();
    const result = await service.issueReturnLabel(
      directive({ packageRequirements: { weightOunces: 999, lengthInches: 9, widthInches: 6, heightInches: 2 } }),
      context,
    );
    expect(result).toMatchObject({ outcome: "failed", failureReason: "unsupported-parcel" });
  });

  it("fails with invalid-buyer-address when the return address is malformed", async () => {
    const { service } = buildService();
    const result = await service.issueReturnLabel(
      directive({ shipFromSnapshot: { name: "", line1: "", city: "", state: "", postalCode: "", country: "" } }),
      context,
    );
    expect(result).toMatchObject({ outcome: "failed", failureReason: "invalid-buyer-address" });
  });

  it("records a machine-readable failure fact when the provider rejects the purchase", async () => {
    const provider = createRecordingProvider({
      purchaseUspsLabel: vi.fn(async () => {
        throw new PostageLabelProviderError({ kind: "validation", message: "address undeliverable" });
      }),
    });
    const { service, db, readAllEvents } = buildService({ provider });
    const result = await service.issueReturnLabel(directive(), context);

    expect(result).toMatchObject({ outcome: "failed", failureReason: "label-purchase-rejected" });
    expect(eventTypes(readAllEvents)).toContain("fulfillment.return-shipment.label-purchase-failed.v1");
    expect(db.peek("return-shipment:rsh_1:purchase-label")?.status).toBe("failed");
  });

  it("voids an unused label and is idempotent on a repeated void", async () => {
    const { service, provider } = buildService();
    await service.issueReturnLabel(directive(), context);

    const voided = await service.voidReturnLabel({ returnShipmentId: "rsh_1", reason: "case cancelled" }, context);
    expect(voided).toMatchObject({ outcome: "voided", refundStatus: "submitted" });
    expect(provider.voidLabel).toHaveBeenCalledTimes(1);

    const again = await service.voidReturnLabel({ returnShipmentId: "rsh_1" }, context);
    expect(again).toMatchObject({ outcome: "noop", reason: "already-voided" });
    expect(provider.voidLabel).toHaveBeenCalledTimes(1);
  });
});
