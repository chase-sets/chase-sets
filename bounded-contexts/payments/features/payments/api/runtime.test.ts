import { describe, expect, it, vi } from "vitest";
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
import { PaymentsRateLimitExceededError, createPaymentRuntime } from "./runtime";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    }),
    readStream: vi.fn(async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    ),
    readAll: vi.fn(async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    }),
  };

  return {
    eventStore,
    readAllEvents: () => allEvents,
  };
}

function createUnusedEventStore(): EventStore {
  return {
    appendToStream: vi.fn(async () => {
      throw new Error("Payment creation should be idempotent.");
    }),
    readStream: vi.fn(async () => []),
    readAll: vi.fn(async () => []),
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
    saveCheckpoint: vi.fn(async (_projectionName: string, _checkpoint: GlobalPosition) => {}),
  };
}

function existingPaymentRow() {
  return {
    payment_id: "pay_existing",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "24.99",
    balance_credit_amount: "0.00",
    processor_amount: "24.99",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
    marketplace_checkout_fee_quote_fingerprint: "quote_1",
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "23.49",
    seller_payout_amount: "24.49",
    seller_payouts: [],
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_existing",
    processor_client_secret: "pi_existing_secret",
    processor_redirect_url: null,
    processor_status: "requires_payment_method",
    three_d_secure_request: null,
    three_d_secure_reason_codes: [],
    liability_shift_status: null,
    liability_shift_authentication_result: null,
    liability_shift_radar_risk_level: null,
    liability_shift_recorded_at: null,
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
    refunded_at: null,
    refunded_amount: "0.00",
    disputed_at: null,
  };
}

function createProcessorGateway() {
  return {
    getPublicConfiguration: vi.fn(() => ({
      processorName: "stripe" as const,
      publishableKey: "pk_test_123",
      confirmationExperience: "processor-managed-form" as const,
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    })),
    createPaymentSession: vi.fn(async (input: { paymentId: string; amount: string; returnUrl?: string | null }) => ({
      processorName: "stripe" as const,
      processorPaymentKind: "payment-intent" as const,
      processorPaymentReference: `pi_${input.paymentId}`,
      processorClientSecret: `secret_${input.paymentId}`,
      processorRedirectUrl: null,
      processorStatus: "requires_payment_method",
    })),
    createCustomer: vi.fn(async () => ({
      processorName: "stripe" as const,
      providerCustomerReference: "cus_buyer",
    })),
    createSetupSession: vi.fn(async () => ({
      processorName: "stripe" as const,
      processorSetupKind: "checkout-setup-session" as const,
      processorSetupReference: "cs_setup",
      processorClientSecret: null,
      processorRedirectUrl: "https://checkout.stripe.test/setup",
      processorStatus: "open",
    })),
    retrieveSetupSessionResult: vi.fn(async () => ({
      processorName: "stripe" as const,
      processorSetupReference: "cs_setup",
      processorStatus: "complete",
      setupIntentReference: "seti_setup",
      savedPaymentMethod: null,
    })),
    retrieveSavedPaymentMethod: vi.fn(async () => null),
    detachSavedPaymentMethod: vi.fn(async () => null),
    retrievePaymentResult: vi.fn(async () => null),
    retrievePaymentResultByPaymentId: vi.fn(async () => null),
    createRefund: vi.fn(async () => {
      throw new Error("Refunds are not part of this test.");
    }),
    parseWebhook: vi.fn(async () => null),
  };
}

function createOrderInputDb(
  options: Readonly<{
    savedCheckoutInstrumentRows?: readonly Record<string, unknown>[];
    accountRiskRows?: readonly Record<string, unknown>[];
  }> = {},
) {
  const reservations = new Map<string, Record<string, unknown>>();
  const savedCheckoutInstrumentRows = [...(options.savedCheckoutInstrumentRows ?? [])].map((row) => ({ ...row }));
  const accountRiskRows = [...(options.accountRiskRows ?? [])].map((row) => ({ ...row }));
  const savedCheckoutSetupSessions = new Map<string, Record<string, unknown>>();
  const revokedAgentGrants = new Map<string, Record<string, unknown>>();
  const providerCustomers = new Map<string, Record<string, unknown>>();
  const sourceReservationKey = (sourceContext: unknown, sourceReferenceId: unknown) =>
    typeof sourceContext === "string" && typeof sourceReferenceId === "string"
      ? `${sourceContext}:${sourceReferenceId}`
      : null;
  const orderReservationKey = (buyerAccountId: unknown, orderSetKey: unknown) =>
    typeof buyerAccountId === "string" && typeof orderSetKey === "string" ? `${buyerAccountId}:${orderSetKey}` : null;
  const reservationRow = (
    paymentId: unknown,
    buyerAccountId: unknown,
    orderSetKey: unknown,
    orderIds: unknown,
    sourceContext: unknown,
    sourceReferenceId: unknown,
    createdAt: unknown,
  ) => ({
    payment_id: paymentId,
    buyer_account_id: buyerAccountId,
    order_set_key: orderSetKey,
    order_ids: typeof orderIds === "string" ? JSON.parse(orderIds) : [],
    source_context: sourceContext,
    source_reference_id: sourceReferenceId,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
  });
  const sortSavedCheckoutInstrumentRows = (rows: readonly Record<string, unknown>[]) =>
    [...rows].sort((left, right) => {
      if (Boolean(left.is_default) !== Boolean(right.is_default)) {
        return Boolean(left.is_default) ? -1 : 1;
      }
      const readiness = String(left.readiness).localeCompare(String(right.readiness));
      if (readiness !== 0) {
        return readiness;
      }
      const updated = String(right.updated_at).localeCompare(String(left.updated_at));
      if (updated !== 0) {
        return updated;
      }
      return String(left.instrument_id).localeCompare(String(right.instrument_id));
    });
  const savedCheckoutInstrumentRow = (params: readonly unknown[]) => ({
    instrument_id: params[0],
    account_id: params[1],
    agent_grant_id: params[2] ?? null,
    payment_method_category: params[3],
    provider: params[4],
    provider_customer_reference: params[5],
    provider_reference: params[6],
    provider_fingerprint: params[7] ?? null,
    display_label: params[8],
    confirmation_experience: params[9],
    readiness: params[10],
    allow_redisplay: params[11],
    consent_id: params[12],
    consent_text: params[13],
    is_default: Boolean(params[14]),
    removed_at: params[15],
    created_at: params[16],
    updated_at: params[16],
  });

  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO payments_provider_customers")) {
        const key = `${params?.[0]}:${params?.[1]}`;
        const existing = providerCustomers.get(key);
        const row = {
          account_id: params?.[0],
          provider: params?.[1],
          provider_customer_reference: params?.[2],
          display_name: params?.[3] ?? existing?.display_name ?? null,
          email: params?.[4] ?? existing?.email ?? null,
          created_at: existing?.created_at ?? params?.[5],
          updated_at: params?.[5],
        };
        providerCustomers.set(key, row);
        return { rows: [row] };
      }

      if (sql.includes("FROM payments_provider_customers")) {
        return { rows: [providerCustomers.get(`${params?.[0]}:${params?.[1]}`)].filter(Boolean) };
      }

      if (sql.includes("INSERT INTO payments_revoked_agent_grants")) {
        const key = `${params?.[0]}:${params?.[1]}`;
        revokedAgentGrants.set(key, {
          account_id: params?.[0],
          agent_grant_id: params?.[1],
          revoked_at: params?.[2],
        });
        return { rows: [] };
      }

      if (sql.includes("FROM payments_revoked_agent_grants")) {
        return { rows: [revokedAgentGrants.get(`${params?.[0]}:${params?.[1]}`)].filter(Boolean) };
      }

      if (sql.includes("INSERT INTO payments_saved_checkout_setup_sessions")) {
        const row = {
          setup_reference_id: params?.[0],
          account_id: params?.[1],
          agent_grant_id: params?.[2] ?? null,
          provider: params?.[3],
          provider_customer_reference: params?.[4],
          processor_setup_reference: params?.[5],
          processor_client_secret: params?.[6],
          processor_redirect_url: params?.[7],
          processor_status: params?.[8],
          consent_id: params?.[9],
          consent_text: params?.[10],
          completed_at: null,
          created_at: params?.[11],
          updated_at: params?.[11],
        };
        savedCheckoutSetupSessions.set(String(row.setup_reference_id), row);
        return { rows: [row] };
      }

      if (sql.includes("FROM payments_saved_checkout_setup_sessions")) {
        const row = [...savedCheckoutSetupSessions.values()].find((session) =>
          sql.includes("processor_setup_reference = $1")
            ? session.processor_setup_reference === params?.[0]
            : session.setup_reference_id === params?.[0],
        );
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("UPDATE payments_saved_checkout_setup_sessions")) {
        for (const session of savedCheckoutSetupSessions.values()) {
          if (session.processor_setup_reference === params?.[0]) {
            session.processor_status = params?.[1];
            session.completed_at ??= params?.[2];
            session.updated_at = params?.[2];
          }
        }
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO payments_saved_checkout_instruments")) {
        if (params?.[14] === true) {
          for (const row of savedCheckoutInstrumentRows) {
            if (row.account_id === params[1]) {
              row.is_default = false;
              row.updated_at = params[16];
            }
          }
        }
        const existing = savedCheckoutInstrumentRows.find(
          (row) => row.provider === params?.[4] && row.provider_reference === params?.[6],
        );
        if (existing) {
          Object.assign(existing, {
            account_id: params?.[1],
            agent_grant_id: params?.[2] ?? null,
            payment_method_category: params?.[3],
            provider_customer_reference: params?.[5],
            provider_fingerprint: params?.[7] ?? existing.provider_fingerprint ?? null,
            display_label: params?.[8],
            confirmation_experience: params?.[9],
            readiness: params?.[10],
            allow_redisplay: params?.[11],
            consent_id: params?.[12] ?? existing.consent_id,
            consent_text: params?.[13] ?? existing.consent_text,
            is_default: Boolean(params?.[14]),
            removed_at: params?.[15],
            updated_at: params?.[16],
          });
          return { rows: [existing] };
        }
        const row = savedCheckoutInstrumentRow(params ?? []);
        savedCheckoutInstrumentRows.push(row);
        return { rows: [row] };
      }

      if (sql.includes("UPDATE payments_saved_checkout_instruments") && sql.includes("is_default = instrument_id")) {
        for (const row of savedCheckoutInstrumentRows) {
          if (row.account_id === params?.[0] && row.readiness !== "removed") {
            row.is_default = row.instrument_id === params?.[1];
            row.updated_at = params?.[2];
          }
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE payments_saved_checkout_instruments") && sql.includes("readiness = 'removed'")) {
        for (const row of savedCheckoutInstrumentRows) {
          if (row.account_id === params?.[0] && row.instrument_id === params?.[1]) {
            row.readiness = "removed";
            row.is_default = false;
            row.removed_at = params?.[2];
            row.updated_at = params?.[2];
          }
        }
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO payments_saved_checkout_instrument_audit")) {
        return { rows: [] };
      }

      if (sql.includes("FROM payments_saved_checkout_instruments")) {
        if (sql.includes("WHERE provider = $1")) {
          return {
            rows: savedCheckoutInstrumentRows.filter(
              (row) => row.provider === params?.[0] && row.provider_reference === params?.[1],
            ),
          };
        }
        const accountRows = savedCheckoutInstrumentRows.filter((row) => row.account_id === params?.[0]);
        if (sql.includes("agent_grant_id = $2")) {
          return {
            rows: accountRows.filter((row) => row.agent_grant_id === params?.[1] && row.readiness !== "removed"),
          };
        }
        if (sql.includes("instrument_id = $2")) {
          return { rows: accountRows.filter((row) => row.instrument_id === params?.[1]) };
        }
        return { rows: sortSavedCheckoutInstrumentRows(accountRows) };
      }

      if (sql.includes("FROM payments_account_risk_sources")) {
        return { rows: accountRiskRows.filter((row) => row.account_id === params?.[0]) };
      }

      if (sql.includes("INSERT INTO payments_payment_creation_reservations")) {
        const sourceKey = sourceReservationKey(params?.[4], params?.[5]);
        const orderKey = orderReservationKey(params?.[1], params?.[2]);
        if (
          (sourceKey && reservations.has(`source:${sourceKey}`)) ||
          (orderKey && reservations.has(`order:${orderKey}`))
        ) {
          return { rows: [] };
        }
        const row = reservationRow(
          params?.[0],
          params?.[1],
          params?.[2],
          params?.[3],
          params?.[4],
          params?.[5],
          params?.[6],
        );
        if (sourceKey) {
          reservations.set(`source:${sourceKey}`, row);
        }
        if (orderKey) {
          reservations.set(`order:${orderKey}`, row);
        }
        return { rows: [row] };
      }

      if (sql.includes("FROM payments_payment_creation_reservations") && sql.includes("source_context = $1")) {
        const sourceKey = sourceReservationKey(params?.[0], params?.[1]);
        return { rows: sourceKey ? [reservations.get(`source:${sourceKey}`)].filter(Boolean) : [] };
      }

      if (sql.includes("FROM payments_payment_creation_reservations") && sql.includes("buyer_account_id = $1")) {
        const orderKey = orderReservationKey(params?.[0], params?.[1]);
        return { rows: orderKey ? [reservations.get(`order:${orderKey}`)].filter(Boolean) : [] };
      }

      if (sql.includes("UPDATE payments_payment_creation_reservations")) {
        return { rows: [] };
      }

      if (sql.includes("FROM payments_order_inputs")) {
        expect(params).toEqual(["acc_buyer", ["ord_1"]]);
        return {
          rows: [
            {
              order_id: "ord_1",
              buyer_account_id: "acc_buyer",
              buyer_email: "buyer@example.com",
              seller_account_id: "acc_seller",
              sales_tax_amount: "1.57",
              total_amount: "24.99",
              marketplace_sales_fee_amount: "1.00",
              marketplace_checkout_fee_amount: "0.50",
              seller_net_amount: "23.49",
              seller_item_net_amount: "23.49",
              shipping_allowance_amount: "1.00",
              shipping_overage_amount: "3.99",
              seller_shipping_payout_amount: "1.00",
              seller_payout_amount: "24.49",
              shipping_allowance_percentage_bps: 500,
              terms_schedule_id: null,
              terms_agreement_id: null,
              terms_resolved_at: "2026-04-29T00:00:00.000Z",
              status: "pending-payment",
            },
          ],
        };
      }

      return { rows: [] };
    }),
    readSavedCheckoutInstruments: () => sortSavedCheckoutInstrumentRows(savedCheckoutInstrumentRows),
  };
}

function createReconciliationDb(options: {
  paymentsNeedingReconciliation?: () => readonly Record<string, unknown>[];
  providerOperationsNeedingReconciliation?: () => readonly Record<string, unknown>[];
  paymentById?: (paymentId: string) => Record<string, unknown> | null;
}) {
  const reconciliationSummaries: unknown[] = [];
  const succeededProviderOperations: readonly unknown[][] = [];
  const failedProviderOperations: readonly unknown[][] = [];
  const providerIdempotencyKeys: readonly unknown[][] = [];
  const webhookEvents: readonly unknown[][] = [];
  const processedWebhookEventIds = new Set<string>();
  const orderInputDb = createOrderInputDb();

  const db = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM payments_saved_checkout_instruments")) {
        return { rows: [] };
      }

      if (sql.includes("payments_payment_creation_reservations")) {
        return orderInputDb.query(sql, params);
      }

      if (sql.includes("FROM payments_order_inputs")) {
        return orderInputDb.query(sql, params);
      }

      if (sql.includes("FROM payments_provider_webhook_events")) {
        const providerEventId = String(params?.[0] ?? "");
        return {
          rows: processedWebhookEventIds.has(providerEventId) ? [{ provider_event_id: providerEventId }] : [],
          rowCount: processedWebhookEventIds.has(providerEventId) ? 1 : 0,
        };
      }

      if (sql.includes("INSERT INTO payments_provider_webhook_events")) {
        (webhookEvents as unknown[][]).push([...(params ?? [])]);
        processedWebhookEventIds.add(String(params?.[0] ?? ""));
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("payment-provider-operation-reconciliation")) {
        return { rows: [...(options.providerOperationsNeedingReconciliation?.() ?? [])] };
      }

      if (sql.includes("FROM payments_provider_operations") && sql.includes("WHERE status = 'pending'")) {
        return { rows: [...(options.providerOperationsNeedingReconciliation?.() ?? [])] };
      }

      if (sql.includes("payment-reconciliation")) {
        return { rows: [...(options.paymentsNeedingReconciliation?.() ?? [])] };
      }

      if (sql.includes("FROM payments_payment_pages") && sql.includes("status = 'pending-confirmation'")) {
        return { rows: [...(options.paymentsNeedingReconciliation?.() ?? [])] };
      }

      if (sql.includes("WHERE payment_id = $1") && params?.[0]) {
        const payment = options.paymentById?.(String(params[0])) ?? null;
        return { rows: payment ? [payment] : [] };
      }

      if (sql.includes("INSERT INTO payments_reconciliation_runs")) {
        reconciliationSummaries.push(JSON.parse(String(params?.[5] ?? "{}")));
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE payments_provider_operations") && sql.includes("status = 'succeeded'")) {
        (succeededProviderOperations as unknown[][]).push([...(params ?? [])]);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE payments_provider_operations") && sql.includes("status = 'failed'")) {
        (failedProviderOperations as unknown[][]).push([...(params ?? [])]);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO payments_provider_idempotency_keys")) {
        (providerIdempotencyKeys as unknown[][]).push([...(params ?? [])]);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO payments_provider_operations")) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    db,
    reconciliationSummaries,
    succeededProviderOperations,
    failedProviderOperations,
    providerIdempotencyKeys,
    webhookEvents,
  };
}

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_buyer" as never,
  },
};

describe("payment runtime", () => {
  it("returns account order overlays from Payments order inputs", async () => {
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway: createProcessorGateway(),
    });

    const orders = await services.listAccountOrderInputs({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
    });

    expect(orders).toEqual([
      expect.objectContaining({
        order_id: "ord_1",
        buyer_email: "buyer@example.com",
        sales_tax_amount: "1.57",
        total_amount: "24.99",
        seller_payout_amount: "24.49",
      }),
    ]);
  });

  it("does not mark provider webhooks processed when the payment target is not ready", async () => {
    const processorGateway = createProcessorGateway();
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_refund_before_payment",
      processorName: "stripe",
      kind: "payment-refunded",
      processorPaymentReference: "pi_missing",
      processorRefundReference: "re_missing",
      processorStatus: "succeeded",
      amount: "12.50",
      occurredAt: "2026-04-29T00:10:00.000Z",
    } as never);
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_provider_webhook_events")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO payments_provider_webhook_events")) {
          throw new Error("Provider event should not be marked processed before payment effects commit.");
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).rejects.toThrow(
      "Payment webhook target was not found.",
    );
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO payments_provider_webhook_events")),
    ).toBe(false);
  });

  it("records Shared Payment Token provider events as acknowledged ignored inbox rows", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const { db, webhookEvents } = createReconciliationDb({});
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_spt_used",
      processorName: "stripe",
      kind: "shared-payment-token-used",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_agentic",
      providerObjectReference: "spt_123",
      internalPaymentId: "pay_agentic",
      processorStatus: "used",
      failureCode: null,
      failureMessage: null,
      occurredAt: "2026-04-29T00:10:00.000Z",
    } as never);
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: true,
    });
    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: true,
    });

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]).toEqual([
      "evt_spt_used",
      "stripe",
      "shared-payment-token-used",
      "spt_123",
      expect.any(String),
    ]);
    expect(readAllEvents()).toEqual([]);
  });

  it("records early fraud warnings, refunds undisputed captured payments, and ignores redelivery", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const paymentsById = new Map<string, Record<string, unknown>>();
    const { db, webhookEvents } = createReconciliationDb({
      paymentById: (paymentId) => paymentsById.get(paymentId) ?? null,
    });
    const refunds = {
      issueRefund: vi.fn(async () => ({ refundId: "rfd_fraud_issfr_123" as never, version: 1 })),
    };
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
      refunds,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        currencyCode: "usd",
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    await services.commandHandler({
      streamId: `payments.payment-${payment.payment_id}`,
      command: {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-07-06T12:00:00.000Z",
      },
      context,
    });
    paymentsById.set(payment.payment_id, {
      ...payment,
      status: "captured",
      processor_status: "succeeded",
      captured_at: "2026-07-06T12:00:00.000Z",
      seller_payouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "22.99",
          shippingAllowanceAmount: "1.50",
          sellerShippingPayoutAmount: "1.50",
          sellerPayoutAmount: "24.49",
        },
      ],
    });
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_efw",
      kind: "payment-early-fraud-warning",
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      providerObjectReference: "issfr_123",
      providerChargeReference: "ch_123",
      internalPaymentId: payment.payment_id,
      processorStatus: "early_fraud_warning",
      failureCode: "card_never_received",
      failureMessage: null,
      fraudType: "card_never_received",
      chargeDisputed: false,
      occurredAt: "2026-07-06T12:05:00.000Z",
    } as never);

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: false,
    });
    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: true,
    });

    expect(readAllEvents().map((event) => event.eventType)).toContain("payments.payment-fraud-warning-received");
    expect(
      readAllEvents().filter((event) => event.eventType === "payments.payment-fraud-warning-received"),
    ).toHaveLength(1);
    expect(refunds.issueRefund).toHaveBeenCalledTimes(1);
    expect(refunds.issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "rfd_fraud_issfr_123",
        paymentId: payment.payment_id,
        orderIds: ["ord_1"],
        amount: "26.05",
      }),
      context,
    );
    expect(webhookEvents).toHaveLength(1);
  });

  it("records Stripe dispute lifecycle metadata once across webhook redelivery", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const paymentsById = new Map<string, Record<string, unknown>>();
    const { db, webhookEvents } = createReconciliationDb({
      paymentById: (paymentId) => paymentsById.get(paymentId) ?? null,
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        currencyCode: "usd",
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    await services.commandHandler({
      streamId: `payments.payment-${payment.payment_id}`,
      command: {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-07-06T12:00:00.000Z",
      },
      context,
    });
    paymentsById.set(payment.payment_id, {
      ...payment,
      status: "captured",
      processor_status: "succeeded",
      captured_at: "2026-07-06T12:00:00.000Z",
      seller_payouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "22.99",
          shippingAllowanceAmount: "1.50",
          sellerShippingPayoutAmount: "1.50",
          sellerPayoutAmount: "24.49",
        },
      ],
    });
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_dispute_created",
      kind: "payment-disputed",
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      providerObjectReference: "dp_123",
      providerChargeReference: "ch_123",
      internalPaymentId: payment.payment_id,
      processorStatus: "needs_response",
      failureCode: "charge.dispute.created",
      failureMessage: "needs_response",
      disputeLifecycleState: "created",
      disputeStatus: "needs_response",
      disputeReason: "fraudulent",
      disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
      amount: "10.00",
      currencyCode: "usd",
      occurredAt: "2026-07-06T12:05:00.000Z",
    } as never);

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: false,
    });
    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: true,
    });

    const disputeEvents = readAllEvents().filter((event) => event.eventType === "payments.payment-disputed");
    expect(disputeEvents).toHaveLength(1);
    expect(disputeEvents[0]?.payload).toMatchObject({
      providerEventId: "evt_dispute_created",
      providerDisputeId: "dp_123",
      providerChargeReference: "ch_123",
      disputeLifecycleState: "created",
      disputeReason: "fraudulent",
      disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
      sellerPayouts: [expect.objectContaining({ sellerAccountId: "acc_seller" })],
    });
    expect(webhookEvents).toHaveLength(1);
  });

  it("reuses checkout-sourced payments by checkout session id", async () => {
    const processorGateway = {
      getPublicConfiguration: vi.fn(() => ({
        processorName: "stripe" as const,
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form" as const,
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      })),
      createPaymentSession: vi.fn(async () => {
        throw new Error("Processor payment should not be recreated.");
      }),
      createCustomer: vi.fn(async () => ({
        processorName: "stripe" as const,
        providerCustomerReference: "cus_buyer",
      })),
      createSetupSession: vi.fn(async () => ({
        processorName: "stripe" as const,
        processorSetupKind: "checkout-setup-session" as const,
        processorSetupReference: "cs_setup",
        processorClientSecret: null,
        processorRedirectUrl: "https://checkout.stripe.test/setup",
        processorStatus: "open",
      })),
      retrieveSetupSessionResult: vi.fn(async () => ({
        processorName: "stripe" as const,
        processorSetupReference: "cs_setup",
        processorStatus: "complete",
        setupIntentReference: "seti_setup",
        savedPaymentMethod: null,
      })),
      retrieveSavedPaymentMethod: vi.fn(async () => null),
      detachSavedPaymentMethod: vi.fn(async () => null),
      retrievePaymentResult: vi.fn(async () => null),
      retrievePaymentResultByPaymentId: vi.fn(async () => null),
      createRefund: vi.fn(async () => {
        throw new Error("Refunds are not part of this test.");
      }),
      parseWebhook: vi.fn(async () => null),
    };
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("source_context = $1");
        expect(params).toEqual(["checkout", "chk_1", "acc_buyer"]);
        return { rows: [existingPaymentRow()] };
      }),
    };
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      {
        tenantId: "tnt_identity" as never,
        audit: {
          performedByUserId: "usr_1" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    );

    expect(result).toMatchObject({
      payment_id: "pay_existing",
      source_context: "checkout",
      source_reference_id: "chk_1",
      processor_publishable_key: "pk_test_123",
    });
    expect(processorGateway.createPaymentSession).not.toHaveBeenCalled();
  });

  it("single-flights concurrent checkout-sourced payment creation", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const releaseProviderSession = createDeferred();
    const providerSessionEntered = new Promise<void>((resolve) => {
      processorGateway.createPaymentSession.mockImplementation(async (input: { paymentId: string }) => {
        resolve();
        await releaseProviderSession.promise;
        return {
          processorName: "stripe" as const,
          processorPaymentKind: "payment-intent" as const,
          processorPaymentReference: `pi_${input.paymentId}`,
          processorClientSecret: `secret_${input.paymentId}`,
          processorRedirectUrl: null,
          processorStatus: "requires_payment_method",
        };
      });
    });
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const input = {
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      sourceContext: "checkout",
      sourceReferenceId: "chk_1",
    };

    const first = services.createAccountPayment(input, context);
    await providerSessionEntered;
    const second = services.createAccountPayment(input, context);
    releaseProviderSession.resolve();
    const [firstPayment, secondPayment] = await Promise.all([first, second]);

    expect(firstPayment.payment_id).toBe(secondPayment.payment_id);
    expect(firstPayment.processor_payment_reference).toBe(secondPayment.processor_payment_reference);
    expect(processorGateway.createPaymentSession).toHaveBeenCalledTimes(1);
    expect(readAllEvents().filter((event) => event.eventType === "payments.payment-created")).toHaveLength(1);
  });

  it.each([
    ["different source", { sourceContext: "checkout", sourceReferenceId: "chk_2" }],
    ["null source", { sourceContext: null, sourceReferenceId: null }],
  ])("rejects the same order set with a %s while a payment is active", async (_label, conflictingSource) => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const releaseProviderSession = createDeferred();
    const providerSessionEntered = new Promise<void>((resolve) => {
      processorGateway.createPaymentSession.mockImplementation(async (input: { paymentId: string }) => {
        resolve();
        await releaseProviderSession.promise;
        return {
          processorName: "stripe" as const,
          processorPaymentKind: "payment-intent" as const,
          processorPaymentReference: `pi_${input.paymentId}`,
          processorClientSecret: `secret_${input.paymentId}`,
          processorRedirectUrl: null,
          processorStatus: "requires_payment_method",
        };
      });
    });
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const first = services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      context,
    );
    await providerSessionEntered;

    await expect(
      services.createAccountPayment(
        {
          accountId: "acc_buyer" as never,
          orderIds: ["ord_1" as never],
          paymentMethodCategory: "card",
          marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
          ...conflictingSource,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "active_payment_exists_for_order_set" });

    releaseProviderSession.resolve();
    await first;
    expect(processorGateway.createPaymentSession).toHaveBeenCalledTimes(1);
  });

  it("requests 3DS step-up for card payments when account risk warrants it", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const db = createOrderInputDb({
      accountRiskRows: [
        {
          account_id: "acc_buyer",
          manual_payout_review: true,
          stripe_fraud_flag: true,
          stripe_fraud_flagged_at: "2026-07-06T12:00:00.000Z",
          stripe_fraud_signal_count: 1,
          stripe_review_open_count: 1,
          updated_at: "2026-07-06T12:00:00.000Z",
        },
      ],
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCustomerReference: "cus_buyer",
        cardAuthentication: {
          requestThreeDSecure: "any",
          reasonCodes: ["stripe-fraud-flag", "stripe-fraud-review-open", "manual-payout-review"],
        },
      }),
    );
    expect(payment).toMatchObject({
      three_d_secure_request: "any",
      three_d_secure_reason_codes: ["stripe-fraud-flag", "stripe-fraud-review-open", "manual-payout-review"],
    });
    expect(readAllEvents()[0]?.payload).toMatchObject({
      threeDSecureRequest: "any",
      threeDSecureReasonCodes: ["stripe-fraud-flag", "stripe-fraud-review-open", "manual-payout-review"],
    });
  });

  it("keeps ordinary low-risk card payments on automatic 3DS", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cardAuthentication: {
          requestThreeDSecure: "automatic",
          reasonCodes: [],
        },
      }),
    );
    expect(payment).toMatchObject({
      three_d_secure_request: "automatic",
      three_d_secure_reason_codes: [],
    });
    expect(readAllEvents()[0]?.payload).toMatchObject({
      threeDSecureRequest: "automatic",
      threeDSecureReasonCodes: [],
    });
  });

  it("keeps guest payments customer-less", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        isGuestCheckout: true,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createCustomer).not.toHaveBeenCalled();
    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerReference: null }),
    );
  });

  it("reuses the account provider customer mapping on payment retries", async () => {
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
    });

    await expect(services.ensureProviderCustomer({ accountId: "acc_buyer" as never })).resolves.toMatchObject({
      provider_customer_reference: "cus_buyer",
    });
    await expect(services.ensureProviderCustomer({ accountId: "acc_buyer" as never })).resolves.toMatchObject({
      provider_customer_reference: "cus_buyer",
    });

    expect(processorGateway.createCustomer).toHaveBeenCalledTimes(1);
    expect(processorGateway.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "payments:account:acc_buyer:stripe:customer" }),
    );
  });

  it("applies available balance credit and creates an external payment for the remainder", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const balanceCreditResolver = {
      resolveBalanceCredit: vi.fn(async () => ({
        requestedAmount: "10.00",
        appliedAmount: "10.00",
        remainingExternalAmount: "14.99",
      })),
    };
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
      balanceCreditResolver,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      requestedBalanceCreditAmount: "10.00",
      paymentMethodCategory: "card",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        requestedBalanceCreditAmount: "10.00",
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      context,
    );

    expect(balanceCreditResolver.resolveBalanceCredit).toHaveBeenCalledWith({
      buyerAccountId: "acc_buyer",
      currencyCode: "usd",
      requestedAmount: "10.00",
      orderTotalAmount: "24.99",
    });
    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "15.75",
        paymentMethodCategory: "card",
      }),
    );
    const providerOperationCall = db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO payments_provider_operations"),
    );
    expect(providerOperationCall).toBeTruthy();
    expect(String(providerOperationCall![0])).not.toContain("request_json");
    const providerOperationParams = providerOperationCall![1] as readonly unknown[];
    expect(providerOperationParams).toHaveLength(7);
    expect(JSON.stringify(providerOperationParams)).not.toContain("clientRiskContext");
    expect(JSON.stringify(providerOperationParams)).not.toContain("savedCheckoutInstrument");
    expect(db.query.mock.invocationCallOrder[db.query.mock.calls.indexOf(providerOperationCall!)]).toBeLessThan(
      processorGateway.createPaymentSession.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      amount: "25.75",
      balance_credit_amount: "10.00",
      processor_amount: "15.75",
      marketplace_checkout_fee_amount: "0.76",
      seller_payout_amount: "24.49",
      seller_payouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "23.49",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "24.49",
        },
      ],
      status: "pending-confirmation",
    });
    expect(readAllEvents()[0]?.payload).toMatchObject({
      sellerPayoutAmount: "24.49",
      sellerPayouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "23.49",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "24.49",
        },
      ],
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual(["payments.payment-created"]);
  });

  it("captures a payment immediately when balance credit covers the full amount", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
      balanceCreditResolver: {
        resolveBalanceCredit: vi.fn(async () => ({
          requestedAmount: "24.99",
          appliedAmount: "24.99",
          remainingExternalAmount: "0.00",
        })),
      },
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      requestedBalanceCreditAmount: "24.99",
      paymentMethodCategory: "platform-credit",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        requestedBalanceCreditAmount: "24.99",
        paymentMethodCategory: "platform-credit",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createPaymentSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      amount: "24.99",
      balance_credit_amount: "24.99",
      processor_amount: "0.00",
      processor_status: "balance-credit-captured",
      seller_payout_amount: "24.49",
      status: "captured",
    });
    expect(readAllEvents()[1]?.payload).toMatchObject({
      sellerPayoutAmount: "24.49",
      sellerPayouts: [
        expect.objectContaining({
          orderId: "ord_1",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
        }),
      ],
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
    ]);
  });

  it("resolves the checkout processing-fee policy from the injected resolver and re-quotes stale fees after a mid-session revision", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    let policy = {
      value: {
        enabledJurisdictions: ["US"],
        base: { percentageBps: 290, fixedAmount: "0.30" },
        methodAdjustments: [
          { paymentMethodCategory: "card" as const, percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
          { paymentMethodCategory: "bank-account" as const, percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
          { paymentMethodCategory: "platform-credit" as const, percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
        ],
      },
      source: "policy" as const,
      documentId: "pol_checkout_fee_1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
    const checkoutProcessingFeePolicyResolver = {
      resolveCheckoutProcessingFeePolicy: vi.fn(async () => policy),
    };
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
      checkoutProcessingFeePolicyResolver,
    });

    const statusBeforeRevision = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    expect(statusBeforeRevision.marketplace_checkout_fee).toMatchObject({
      marketplace_checkout_fee_amount: "1.06",
      total_amount: "26.05",
    });
    expect(checkoutProcessingFeePolicyResolver.resolveCheckoutProcessingFeePolicy).toHaveBeenCalled();

    // An admin revises the checkout processing-fee policy mid-session.
    policy = {
      ...policy,
      value: {
        enabledJurisdictions: ["US"],
        base: { percentageBps: 350, fixedAmount: "0.35" },
        methodAdjustments: [
          { paymentMethodCategory: "card" as const, percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
          { paymentMethodCategory: "bank-account" as const, percentageBpsDelta: -300, fixedAmountDelta: "-0.35" },
          { paymentMethodCategory: "platform-credit" as const, percentageBpsDelta: -350, fixedAmountDelta: "-0.35" },
        ],
      },
      documentId: "pol_checkout_fee_2",
    };

    // Paying with the pre-revision fingerprint is rejected as stale -- the
    // 409 `fee_quote_stale` flow the checkout route already maps to a
    // re-quote-required response.
    await expect(
      services.createAccountPayment(
        {
          accountId: "acc_buyer" as never,
          orderIds: ["ord_1" as never],
          currencyCode: "usd",
          paymentMethodCategory: "card",
          marketplaceCheckoutFeeQuoteFingerprint: statusBeforeRevision.marketplace_checkout_fee.quote_fingerprint,
        },
        context,
      ),
    ).rejects.toThrow(/^fee_quote_stale:/);

    // Re-quoting picks up the revised policy...
    const statusAfterRevision = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    expect(statusAfterRevision.marketplace_checkout_fee).toMatchObject({
      marketplace_checkout_fee_amount: "1.27",
      total_amount: "26.26",
    });
    expect(statusAfterRevision.marketplace_checkout_fee.quote_fingerprint).not.toBe(
      statusBeforeRevision.marketplace_checkout_fee.quote_fingerprint,
    );

    // ...and paying with the fresh fingerprint succeeds.
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        currencyCode: "usd",
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: statusAfterRevision.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    expect(payment.amount).toBe("26.26");

    const publishedPolicy = await services.getMarketplaceCheckoutFeePolicy();
    expect(publishedPolicy).toMatchObject({
      base: { percentage_bps: 350, fixed_amount: "0.35" },
      effective_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("falls back to the compiled checkout processing-fee policy when the resolver reports no active document", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const checkoutProcessingFeePolicyResolver = {
      resolveCheckoutProcessingFeePolicy: vi.fn(async () => ({
        value: {
          enabledJurisdictions: ["US"],
          base: { percentageBps: 290, fixedAmount: "0.30" },
          methodAdjustments: [
            { paymentMethodCategory: "card" as const, percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
            { paymentMethodCategory: "bank-account" as const, percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
            { paymentMethodCategory: "platform-credit" as const, percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
          ],
        },
        source: "fallback" as const,
        documentId: null,
        effectiveFrom: null,
        resolvedAt: "2026-01-01T00:00:00.000Z",
      })),
    };
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
      checkoutProcessingFeePolicyResolver,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    // Byte-identical to the compiled defaults: an empty policy table (no
    // active document) never breaks the checkout hot path.
    expect(status.marketplace_checkout_fee).toMatchObject({
      marketplace_checkout_fee_amount: "1.06",
      total_amount: "26.05",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|24.99|0.00|24.99|1.06|26.05|26.05",
    });

    const publishedPolicy = await services.getMarketplaceCheckoutFeePolicy();
    expect(publishedPolicy).toMatchObject({
      base: { percentage_bps: 290, fixed_amount: "0.30" },
      effective_at: "2026-05-03T00:00:00.000Z",
    });
  });

  it("falls back to the compiled checkout processing-fee policy when no resolver is wired at all", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway: createProcessorGateway(),
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    expect(status.marketplace_checkout_fee).toMatchObject({
      marketplace_checkout_fee_amount: "1.06",
      total_amount: "26.05",
    });
  });

  it("uses an explicit relative return path for processor payment sessions", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "bank-account",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "bank-account",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        returnUrlBase: "https://market.test",
        returnUrlPath: "/checkout/payments/:paymentId",
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodCategory: "bank-account",
        returnUrl: `https://market.test/checkout/payments/${result.payment_id}`,
      }),
    );
  });

  it("validates and passes a saved checkout instrument to the processor", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const db = createOrderInputDb({
      savedCheckoutInstrumentRows: [
        {
          instrument_id: "sci_card_1",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_card_1",
          display_label: "Visa ending in 4242",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_1",
          consent_text: "Save for future checkout.",
          removed_at: null,
          is_default: true,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
        },
      ],
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        savedCheckoutInstrumentId: "sci_card_1",
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        savedCheckoutInstrument: {
          instrumentId: "sci_card_1",
          providerCustomerReference: "cus_buyer",
          providerReference: "pm_card_1",
          confirmationExperience: "off-session-token",
          displayLabel: "Visa ending in 4242",
        },
      }),
    );
    expect(result.saved_checkout_instrument_id).toBe("sci_card_1");
    expect(readAllEvents()[0]?.payload).toMatchObject({
      savedCheckoutInstrumentId: "sci_card_1",
    });
  });

  it("uses the buyer's chosen default saved checkout instrument for fast-path payment creation", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const db = createOrderInputDb({
      savedCheckoutInstrumentRows: [
        {
          instrument_id: "sci_card_1",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_card_1",
          display_label: "Visa ending in 4242",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_1",
          consent_text: "Save for future checkout.",
          removed_at: null,
          is_default: false,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
        },
        {
          instrument_id: "sci_card_2",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_card_2",
          display_label: "Mastercard ending in 4444",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_2",
          consent_text: "Save for future checkout.",
          removed_at: null,
          is_default: true,
          created_at: "2026-04-30T00:00:00.000Z",
          updated_at: "2026-04-30T00:00:00.000Z",
        },
      ],
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        savedCheckoutInstrumentId: "sci_card_2",
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        savedCheckoutInstrument: expect.objectContaining({
          instrumentId: "sci_card_2",
          providerReference: "pm_card_2",
          displayLabel: "Mastercard ending in 4444",
        }),
      }),
    );
  });

  it("blocks saved-card payment creation after repeated declines for the same card fingerprint", async () => {
    const processorGateway = createProcessorGateway();
    const declinedPayment = {
      ...existingPaymentRow(),
      payment_id: "pay_declined",
      processor_payment_reference: "pi_declined",
      status: "pending-confirmation",
    };
    const { db } = createReconciliationDb({
      paymentById: (paymentId) => (paymentId === "pay_declined" ? declinedPayment : null),
    });
    const declineRuntime = createPaymentRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      processorGateway.parseWebhook.mockResolvedValueOnce({
        eventId: `evt_decline_${attempt}`,
        kind: "payment-failed",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: "pi_declined",
        internalPaymentId: "pay_declined",
        processorStatus: "requires_payment_method",
        failureCode: "card_declined",
        failureMessage: "Card was declined.",
        occurredAt: `2026-04-29T00:0${attempt}:00.000Z`,
        savedPaymentMethod: {
          processorName: "stripe",
          providerCustomerReference: "cus_buyer",
          providerReference: `pm_declined_${attempt}`,
          paymentMethodFingerprint: "fp_declined_card",
          paymentMethodCategory: "card",
          displayLabel: "Visa ending in 0002",
          readiness: "ready",
          allowRedisplay: "always",
          removed: false,
        },
      } as never);
      await declineRuntime.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context).catch(() => undefined);
    }

    const creationGateway = createProcessorGateway();
    const creationRuntime = createPaymentRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb({
        savedCheckoutInstrumentRows: [
          {
            instrument_id: "sci_declined_card",
            account_id: "acc_buyer",
            payment_method_category: "card",
            provider: "stripe",
            provider_customer_reference: "cus_buyer",
            provider_reference: "pm_declined_saved",
            provider_fingerprint: "fp_declined_card",
            display_label: "Visa ending in 0002",
            confirmation_experience: "off-session-token",
            readiness: "ready",
            allow_redisplay: "always",
            consent_id: "consent_declined",
            consent_text: "Save for future checkout.",
            removed_at: null,
            is_default: true,
            created_at: "2026-04-29T00:00:00.000Z",
            updated_at: "2026-04-29T00:00:00.000Z",
          },
        ],
      }) as never,
      processorGateway: creationGateway,
    });
    const status = await creationRuntime.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });

    await expect(
      creationRuntime.createAccountPayment(
        {
          accountId: "acc_buyer" as never,
          orderIds: ["ord_1" as never],
          paymentMethodCategory: "card",
          marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
          savedCheckoutInstrumentId: "sci_declined_card",
        },
        context,
      ),
    ).rejects.toBeInstanceOf(PaymentsRateLimitExceededError);
    expect(creationGateway.createPaymentSession).not.toHaveBeenCalled();
  });

  it("makes the first consent-saved checkout instrument default", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    processorGateway.retrieveSetupSessionResult.mockResolvedValue({
      processorName: "stripe",
      processorSetupReference: "cs_setup",
      processorStatus: "complete",
      setupIntentReference: "seti_setup",
      savedPaymentMethod: {
        processorName: "stripe",
        providerCustomerReference: "cus_buyer",
        providerReference: "pm_card_1",
        paymentMethodCategory: "card",
        displayLabel: "Visa ending in 4242",
        readiness: "ready",
        allowRedisplay: "always",
        removed: false,
      },
    } as never);
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const setupSession = await services.createSavedCheckoutSetupSession({ accountId: "acc_buyer" as never });

    const instrument = await services.reconcileSavedCheckoutSetupSession(
      {
        accountId: "acc_buyer" as never,
        setupReference: setupSession.setup_reference_id,
      },
      context,
    );

    expect(instrument).toMatchObject({
      provider_reference: "pm_card_1",
      is_default: true,
    });
    expect(db.readSavedCheckoutInstruments()).toEqual([
      expect.objectContaining({ provider_reference: "pm_card_1", is_default: true }),
    ]);
  });

  it("preserves the existing default when a second checkout instrument is consent-saved", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    processorGateway.retrieveSetupSessionResult
      .mockResolvedValueOnce({
        processorName: "stripe",
        processorSetupReference: "cs_setup",
        processorStatus: "complete",
        setupIntentReference: "seti_setup",
        savedPaymentMethod: {
          processorName: "stripe",
          providerCustomerReference: "cus_buyer",
          providerReference: "pm_card_1",
          paymentMethodCategory: "card",
          displayLabel: "Visa ending in 4242",
          readiness: "ready",
          allowRedisplay: "always",
          removed: false,
        },
      } as never)
      .mockResolvedValueOnce({
        processorName: "stripe",
        processorSetupReference: "cs_setup",
        processorStatus: "complete",
        setupIntentReference: "seti_setup",
        savedPaymentMethod: {
          processorName: "stripe",
          providerCustomerReference: "cus_buyer",
          providerReference: "pm_card_2",
          paymentMethodCategory: "card",
          displayLabel: "Mastercard ending in 4444",
          readiness: "ready",
          allowRedisplay: "always",
          removed: false,
        },
      } as never);
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const firstSetupSession = await services.createSavedCheckoutSetupSession({ accountId: "acc_buyer" as never });
    await services.reconcileSavedCheckoutSetupSession(
      {
        accountId: "acc_buyer" as never,
        setupReference: firstSetupSession.setup_reference_id,
      },
      context,
    );
    const secondSetupSession = await services.createSavedCheckoutSetupSession({ accountId: "acc_buyer" as never });

    const secondInstrument = await services.reconcileSavedCheckoutSetupSession(
      {
        accountId: "acc_buyer" as never,
        setupReference: secondSetupSession.setup_reference_id,
      },
      context,
    );

    expect(secondInstrument).toMatchObject({
      provider_reference: "pm_card_2",
      is_default: false,
    });
    expect(db.readSavedCheckoutInstruments()).toEqual([
      expect.objectContaining({ provider_reference: "pm_card_1", is_default: true }),
      expect.objectContaining({ provider_reference: "pm_card_2", is_default: false }),
    ]);
  });

  it("detaches active saved checkout instruments owned by a revoked agent grant idempotently", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const db = createOrderInputDb({
      savedCheckoutInstrumentRows: [
        {
          instrument_id: "sci_agent_card",
          account_id: "acc_buyer",
          agent_grant_id: "lpa_1",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_agent_card",
          provider_fingerprint: "fp_agent",
          display_label: "Visa ending in 4242",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_1",
          consent_text: "Save this payment method",
          is_default: true,
          removed_at: null,
          created_at: "2026-07-09T00:00:00.000Z",
          updated_at: "2026-07-09T00:00:00.000Z",
        },
        {
          instrument_id: "sci_other_card",
          account_id: "acc_buyer",
          agent_grant_id: "lpa_2",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_other_card",
          provider_fingerprint: "fp_other",
          display_label: "Visa ending in 1881",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_2",
          consent_text: "Save this payment method",
          is_default: false,
          removed_at: null,
          created_at: "2026-07-09T00:00:00.000Z",
          updated_at: "2026-07-09T00:00:00.000Z",
        },
      ],
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.revokeSavedCheckoutInstrumentsForAgentGrant({
      accountId: "acc_buyer" as never,
      agentGrantId: "lpa_1",
      revokedAt: "2026-07-09T01:00:00.000Z",
    });
    const replay = await services.revokeSavedCheckoutInstrumentsForAgentGrant({
      accountId: "acc_buyer" as never,
      agentGrantId: "lpa_1",
      revokedAt: "2026-07-09T01:00:00.000Z",
    });

    expect(result).toEqual({ detached: 1, alreadyRemoved: 0, instrumentIds: ["sci_agent_card"] });
    expect(replay).toEqual({ detached: 0, alreadyRemoved: 0, instrumentIds: [] });
    expect(processorGateway.detachSavedPaymentMethod).toHaveBeenCalledTimes(1);
    expect(processorGateway.detachSavedPaymentMethod).toHaveBeenCalledWith("pm_agent_card");
    expect(db.readSavedCheckoutInstruments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument_id: "sci_agent_card",
          readiness: "removed",
          is_default: false,
          removed_at: "2026-07-09T01:00:00.000Z",
        }),
        expect.objectContaining({
          instrument_id: "sci_other_card",
          readiness: "ready",
        }),
      ]),
    );
  });

  it("detaches a late setup result instead of saving it when the agent grant was already revoked", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    processorGateway.retrieveSetupSessionResult.mockResolvedValue({
      processorName: "stripe",
      processorSetupReference: "cs_setup",
      processorStatus: "complete",
      setupIntentReference: "seti_setup",
      savedPaymentMethod: {
        processorName: "stripe",
        providerCustomerReference: "cus_buyer",
        providerReference: "pm_late_agent_card",
        paymentMethodCategory: "card",
        displayLabel: "Visa ending in 4242",
        readiness: "ready",
        allowRedisplay: "always",
        removed: false,
      },
    } as never);
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const setup = await services.createSavedCheckoutSetupSession({
      accountId: "acc_buyer" as never,
      agentGrantId: "lpa_1",
    });
    await services.revokeSavedCheckoutInstrumentsForAgentGrant({
      accountId: "acc_buyer" as never,
      agentGrantId: "lpa_1",
      revokedAt: "2026-07-09T01:00:00.000Z",
    });
    const instrument = await services.reconcileSavedCheckoutSetupSession(
      { accountId: "acc_buyer" as never, setupReference: setup.setup_reference_id },
      context,
    );

    expect(processorGateway.detachSavedPaymentMethod).toHaveBeenCalledWith("pm_late_agent_card");
    expect(instrument).toMatchObject({
      provider_reference: "pm_late_agent_card",
      agent_grant_id: "lpa_1",
      readiness: "removed",
      removed_at: "2026-07-09T01:00:00.000Z",
    });
    expect(db.readSavedCheckoutInstruments()).toEqual([
      expect.objectContaining({
        provider_reference: "pm_late_agent_card",
        readiness: "removed",
      }),
    ]);
  });

  it("publishes support-safe checkout affordance facts after saved instrument changes", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb({
        savedCheckoutInstrumentRows: [
          {
            instrument_id: "sci_card_1",
            account_id: "acc_buyer",
            payment_method_category: "card",
            provider: "stripe",
            provider_customer_reference: "cus_buyer",
            provider_reference: "pm_card_1",
            display_label: "Visa ending in 4242",
            confirmation_experience: "off-session-token",
            readiness: "ready",
            allow_redisplay: "always",
            consent_id: "consent_1",
            consent_text: "Save for future checkout.",
            removed_at: null,
            is_default: false,
            created_at: "2026-04-29T00:00:00.000Z",
            updated_at: "2026-04-29T00:00:00.000Z",
          },
        ],
      }) as never,
      processorGateway: createProcessorGateway(),
    });

    await services.setSavedCheckoutInstrumentDefault(
      {
        accountId: "acc_buyer" as never,
        instrumentId: "sci_card_1",
      },
      context,
    );

    const published = readAllEvents().find((event) => event.eventType === "payments.checkout-affordances-published");
    expect(published?.streamId).toBe("payments.checkout-affordances-acc_buyer");
    expect(published?.payload).toMatchObject({
      accountId: "acc_buyer",
      savedCheckoutInstruments: [
        {
          instrumentId: "sci_card_1",
          paymentMethodCategory: "card",
          displayLabel: "Visa ending in 4242",
          confirmationExperience: "off-session-token",
          readiness: "ready",
          checkoutEligible: true,
          isDefault: true,
          removedAt: null,
        },
      ],
    });
    expect(JSON.stringify(published?.payload)).not.toContain("provider_reference");
    expect(JSON.stringify(published?.payload)).not.toContain("providerReference");
    expect(JSON.stringify(published?.payload)).not.toContain("provider_customer_reference");
    expect(JSON.stringify(published?.payload)).not.toContain("providerCustomerReference");
    expect(JSON.stringify(published?.payload)).not.toContain("consent");
  });

  it("records authentication-failed liability shift outcomes from provider failures", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const paymentsById = new Map<string, Record<string, unknown>>();
    const { db } = createReconciliationDb({
      paymentById: (paymentId) => paymentsById.get(paymentId) ?? null,
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    paymentsById.set(payment.payment_id, payment);
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_auth_failed",
      kind: "payment-failed",
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      internalPaymentId: payment.payment_id,
      processorStatus: "requires_payment_method",
      failureCode: "authentication_required",
      failureMessage: "3DS authentication failed.",
      occurredAt: "2026-04-29T00:10:00.000Z",
      liabilityShiftOutcome: {
        threeDSecureRequested: "any",
        status: "authentication-failed",
        authenticationResult: "failed",
        radarRiskLevel: "elevated",
      },
    } as never);

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: false,
    });

    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-failed",
      "payments.payment-liability-shift-recorded",
    ]);
    expect(readAllEvents()[2]?.payload).toMatchObject({
      providerEventId: "evt_auth_failed",
      threeDSecureRequested: "any",
      status: "authentication-failed",
      authenticationResult: "failed",
      radarRiskLevel: "elevated",
    });
  });

  it("records shifted liability outcomes once across webhook redelivery", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const paymentsById = new Map<string, Record<string, unknown>>();
    const { db, webhookEvents } = createReconciliationDb({
      paymentById: (paymentId) => paymentsById.get(paymentId) ?? null,
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    paymentsById.set(payment.payment_id, payment);
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_3ds_shifted",
      kind: "payment-captured",
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      internalPaymentId: payment.payment_id,
      processorStatus: "succeeded",
      failureCode: null,
      failureMessage: null,
      occurredAt: "2026-04-29T00:10:00.000Z",
      liabilityShiftOutcome: {
        threeDSecureRequested: "any",
        status: "shifted",
        authenticationResult: "authenticated",
        radarRiskLevel: "normal",
      },
    } as never);

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: false,
    });
    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: true,
    });

    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
      "payments.payment-liability-shift-recorded",
    ]);
    expect(readAllEvents()[2]?.payload).toMatchObject({
      providerEventId: "evt_3ds_shifted",
      threeDSecureRequested: "any",
      status: "shifted",
      authenticationResult: "authenticated",
      radarRiskLevel: "normal",
    });
    expect(webhookEvents).toHaveLength(1);
  });

  it("repairs a stale pending payment captured by the provider and ignores a late duplicate webhook", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const paymentsById = new Map<string, Record<string, unknown>>();
    let stalePayments: Record<string, unknown>[] = [];
    const { db, reconciliationSummaries, webhookEvents } = createReconciliationDb({
      paymentsNeedingReconciliation: () => stalePayments,
      paymentById: (paymentId) => paymentsById.get(paymentId) ?? null,
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });
    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const payment = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );
    paymentsById.set(payment.payment_id, payment);
    stalePayments = [payment];
    processorGateway.retrievePaymentResult.mockResolvedValue({
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      processorStatus: "succeeded",
      outcome: "captured",
      occurredAt: "2026-04-29T00:10:00.000Z",
      internalPaymentId: payment.payment_id,
    } as never);

    const result = await services.scanPaymentsNeedingReconciliation({ limit: 10 }, context);

    expect(result).toMatchObject({
      checked: 1,
      repaired: 1,
      attention: 0,
      provider_operations_checked: 0,
    });
    expect(reconciliationSummaries.at(-1)).toMatchObject({
      repaired: 1,
      attention_items: [],
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
    ]);

    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_late_capture",
      kind: "payment-captured",
      processorName: "stripe",
      processorPaymentKind: payment.processor_payment_kind,
      processorPaymentReference: payment.processor_payment_reference,
      internalPaymentId: payment.payment_id,
      processorStatus: "succeeded",
      failureCode: null,
      failureMessage: null,
      occurredAt: "2026-04-29T00:11:00.000Z",
    } as never);

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).resolves.toEqual({
      received: true,
      ignored: false,
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
    ]);
    expect(webhookEvents).toHaveLength(1);
  });

  it("marks an orphaned pending provider operation failed when support-safe provider lookup finds nothing", async () => {
    const processorGateway = createProcessorGateway();
    const { db, failedProviderOperations } = createReconciliationDb({
      providerOperationsNeedingReconciliation: () => [
        {
          operation_key: "payment:pay_orphan:create",
          provider_name: "stripe",
          operation_kind: "payment-session-create",
          account_id: "acc_buyer",
          payment_id: "pay_orphan",
          idempotency_key: "payments:payment:pay_orphan:create",
          status: "pending",
          provider_object_reference: null,
          error_message: null,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
          completed_at: null,
        },
      ],
      paymentById: () => null,
    });
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.scanPaymentsNeedingReconciliation({ limit: 10 }, context);

    expect(result).toMatchObject({
      checked: 0,
      provider_operations_checked: 1,
      provider_operations_resolved: 1,
      attention: 0,
    });
    expect(failedProviderOperations).toHaveLength(1);
    expect(failedProviderOperations[0]?.[0]).toBe("payment:pay_orphan:create");
    expect(String(failedProviderOperations[0]?.[1])).toContain("Provider payment was not found");
  });

  it("resolves a provider-created orphan operation to operator attention when the local payment aggregate is missing", async () => {
    const processorGateway = createProcessorGateway();
    processorGateway.retrievePaymentResultByPaymentId.mockResolvedValue({
      processorName: "stripe",
      processorPaymentKind: "checkout-session",
      processorPaymentReference: "cs_orphan",
      processorStatus: "paid",
      outcome: "captured",
      occurredAt: "2026-04-29T00:10:00.000Z",
      internalPaymentId: "pay_orphan",
    } as never);
    const { db, reconciliationSummaries, succeededProviderOperations, providerIdempotencyKeys } =
      createReconciliationDb({
        providerOperationsNeedingReconciliation: () => [
          {
            operation_key: "payment:pay_orphan:create",
            provider_name: "stripe",
            operation_kind: "payment-session-create",
            account_id: "acc_buyer",
            payment_id: "pay_orphan",
            idempotency_key: "payments:payment:pay_orphan:create",
            status: "pending",
            provider_object_reference: null,
            error_message: null,
            created_at: "2026-04-29T00:00:00.000Z",
            updated_at: "2026-04-29T00:00:00.000Z",
            completed_at: null,
          },
        ],
        paymentById: () => null,
      });
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.scanPaymentsNeedingReconciliation({ limit: 10 }, context);

    expect(result).toMatchObject({
      checked: 0,
      provider_operations_checked: 1,
      provider_operations_resolved: 1,
      attention: 1,
    });
    expect(succeededProviderOperations[0]?.[0]).toBe("payment:pay_orphan:create");
    expect(succeededProviderOperations[0]?.[1]).toBe("cs_orphan");
    expect(providerIdempotencyKeys).toHaveLength(1);
    expect(reconciliationSummaries.at(-1)).toMatchObject({
      attention_items: [
        expect.objectContaining({
          kind: "provider-operation",
          operation_key: "payment:pay_orphan:create",
          processor_payment_reference: "cs_orphan",
        }),
      ],
    });
  });
});
