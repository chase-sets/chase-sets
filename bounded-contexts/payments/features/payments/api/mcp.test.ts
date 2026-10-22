import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createMcpRoutes,
  type CreateMcpRoutesOptions,
  type McpAuditRecord,
  type McpIdempotencyStore,
} from "@chase-sets/platform-runtime/mcp";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPaymentMcpHandlers } from "./mcp";
import { createPaymentRuntime, type PaymentServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["orders.view"],
} satisfies ResolvedActor;

const managingActor = {
  ...actor,
  permissions: ["orders.view", "orders.manage"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

const payment = {
  payment_id: "pay_1",
  buyer_account_id: "acc_buyer",
  order_ids: ["ord_1"],
  status: "partially-refunded",
  processor_status: "succeeded",
  refunded_amount: "5.00",
  refunded_at: "2026-07-08T00:00:00.000Z",
  disputed_at: null,
  failure_code: null,
  failure_message: null,
  order_refund_caps: [{ orderId: "ord_1", amount: "25.00" }],
  order_refunded_amounts: [{ orderId: "ord_1", amount: "5.00" }],
};

type PaymentMcpTestServices = Pick<
  PaymentServices,
  | "getAccountPayment"
  | "getPaymentMoneyTimeline"
  | "createSavedCheckoutSetupSession"
  | "reconcileSavedCheckoutSetupSession"
>;

function services(): PaymentMcpTestServices {
  return {
    getAccountPayment: vi.fn(async (paymentId, accountId) =>
      accountId === "acc_buyer" ? { ...payment, payment_id: paymentId, buyer_account_id: accountId } : null,
    ),
    getPaymentMoneyTimeline: vi.fn(async () => ({
      payment_id: "pay_1",
      account_id: "acc_buyer",
      items: [{ kind: "payment-refunded", amount: "5.00" }],
    })),
    createSavedCheckoutSetupSession: vi.fn(async () => ({ ...setupSessionRow })),
    reconcileSavedCheckoutSetupSession: vi.fn(async () => readyInstrumentRow),
  } as unknown as PaymentMcpTestServices;
}

describe("payment MCP handlers", () => {
  it("reads payment state with refund and dispute status", async () => {
    const fakeServices = services();
    const handlers = createPaymentMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["payments.get-payment"]?.(
      mcpRequest({ accountId: "acc_buyer", paymentId: "pay_1" }),
    );

    expect(result).toMatchObject({
      accountId: "acc_buyer",
      payment: { payment_id: "pay_1", status: "partially-refunded" },
      status: { paymentStatus: "partially-refunded", refundedAmount: "5.00", disputedAt: null },
    });
    expect(fakeServices.getPaymentMoneyTimeline).toHaveBeenCalledWith({ paymentId: "pay_1", accountId: "acc_buyer" });
  });

  it("returns a compact refund status and reads payment resources", async () => {
    const fakeServices = services();
    const handlers = createPaymentMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["payments.get-refund-status"]?.(mcpRequest({ accountId: "acc_buyer", paymentId: "pay_1" })),
    ).resolves.toMatchObject({
      accountId: "acc_buyer",
      paymentId: "pay_1",
      orderRefundedAmounts: [{ orderId: "ord_1", amount: "5.00" }],
    });

    await expect(
      handlers.resourceHandlers["chase-sets://payments/{accountId}/payments/{paymentId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://payments/acc_buyer/payments/pay_1",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ payment: { payment_id: "pay_1" } });
  });
});

const setupSessionRow = {
  setup_reference_id: "scs_1",
  account_id: "acc_buyer",
  provider: "stripe",
  provider_customer_reference: "cus_1",
  processor_setup_reference: "seti_1",
  processor_client_secret: "seti_1_secret_super_sensitive",
  processor_redirect_url: "https://checkout.stripe.test/setup/scs_1",
  processor_status: "requires-action",
  consent_id: "consent_1",
  consent_text: "Save this card for future purchases.",
  created_at: "2026-07-08T00:00:00.000Z",
  updated_at: "2026-07-08T00:00:00.000Z",
  completed_at: null,
};

const readyInstrumentRow = {
  instrument_id: "sci_1",
  account_id: "acc_buyer",
  payment_method_category: "card" as const,
  provider: "stripe",
  provider_customer_reference: "cus_1",
  provider_reference: "pm_super_sensitive_reference",
  provider_fingerprint: "fp_super_sensitive",
  display_label: "Visa ····4242",
  confirmation_experience: "off-session-token" as const,
  is_default: true,
  readiness: "ready" as const,
  allow_redisplay: "always" as const,
  consent_id: "consent_1",
  consent_text: "Save this card for future purchases.",
  removed_at: null,
  created_at: "2026-07-08T00:00:00.000Z",
  updated_at: "2026-07-08T00:00:00.000Z",
};

type SetupServices = Pick<
  PaymentServices,
  | "getAccountPayment"
  | "getPaymentMoneyTimeline"
  | "createSavedCheckoutSetupSession"
  | "reconcileSavedCheckoutSetupSession"
>;

function setupServices(
  overrides: Partial<{
    setupSession: Record<string, unknown>;
    reconcileResult: Record<string, unknown> | null;
  }> = {},
): SetupServices {
  return {
    ...services(),
    createSavedCheckoutSetupSession: vi.fn(async () => ({ ...setupSessionRow, ...overrides.setupSession })),
    reconcileSavedCheckoutSetupSession: vi.fn(async () =>
      overrides.reconcileResult === undefined ? readyInstrumentRow : overrides.reconcileResult,
    ),
  } as unknown as SetupServices;
}

const setupConfirmationText = "Start Payment Method Setup.";
/** A canonical UUIDv4 owner key: the call's Saved Checkout Instrument Attempt id. */
const setupAttemptKey = "3f2b8c1e-6a4d-4e9b-b7c2-1d0e5f6a7b81";

/**
 * Mounts the Payments handlers behind the real `createMcpRoutes` dispatch with every pre-handler
 * sink observable: the evidence-window lookup, platform idempotency reservation, tool-call lease,
 * and audit. Actor, return URL, confirmation and idempotency key are fixed so a caller varies only
 * the extra arguments.
 */
function setupRouteHarness(
  fakeServices: SetupServices,
  options: Readonly<{ window?: Readonly<{ windowId: string; expiresAt: string }> }> = {},
) {
  const currentOpenWindow = vi.fn(async () => options.window ?? null);
  const handlers = createPaymentMcpHandlers(fakeServices, { currentOpenWindow });
  const reserve = vi.fn<McpIdempotencyStore["reserve"]>(async (input) => ({
    outcome: "reserved",
    record: { ...input, response: null, status: "pending" },
  }));
  const idempotencyStore = { reserve, get: vi.fn(() => null), put: vi.fn(), complete: vi.fn(), abandon: vi.fn() };
  const release = vi.fn();
  const acquire = vi.fn<NonNullable<CreateMcpRoutesOptions["toolCallLimiter"]>["acquire"]>(async () => ({
    allowed: true,
    lease: { release },
  }));
  const records: McpAuditRecord[] = [];
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (context, next) => {
    context.set("actor", managingActor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      ...handlers,
      audit: (record) => {
        records.push(record);
      },
      idempotencyStore,
      toolCallLimiter: { acquire },
    }),
  );

  const call = async (extraArguments: Readonly<Record<string, unknown>>) => {
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "setup_request",
        method: "tools/call",
        params: {
          name: "payments.start-payment-method-setup",
          arguments: {
            accountId: managingActor.accountId,
            returnUrl: "https://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
            confirmationText: setupConfirmationText,
            ...extraArguments,
          },
          confirmation: { confirmed: true, text: setupConfirmationText },
        },
      }),
    });
    return (await response.json()) as { result: Record<string, unknown> };
  };

  return { call, currentOpenWindow, idempotencyStore, acquire, release, records };
}

describe("payment MCP stored-payment-method rail", () => {
  it("J3 refuses dryRun:true at admission before the evidence-window lookup, reservation, lease and setup service", async () => {
    const fakeServices = setupServices();
    const harness = setupRouteHarness(fakeServices);

    const body = await harness.call({ dryRun: true });

    expect(body.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "dryRun is not supported for payment method setup MCP writes yet." }],
    });
    expect(harness.currentOpenWindow).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.reserve).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.complete).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.abandon).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.put).not.toHaveBeenCalled();
    expect(harness.acquire).not.toHaveBeenCalled();
    expect(fakeServices.createSavedCheckoutSetupSession).not.toHaveBeenCalled();
    expect(fakeServices.reconcileSavedCheckoutSetupSession).not.toHaveBeenCalled();
    // The platform's single admission refusal audit is expected; no allowed or failed audit may follow.
    expect(harness.records).toEqual([
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "payments.start-payment-method-setup",
        reason: "dryRun is not supported for payment method setup MCP writes yet.",
      }),
    ]);
  });

  it.each([
    ["omitted", {}],
    ["explicit false", { dryRun: false }],
  ])("creates the same hosted setup through the route when dryRun is %s", async (_label, extraArguments) => {
    const fakeServices = setupServices();
    const harness = setupRouteHarness(fakeServices);

    const body = await harness.call(extraArguments);

    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({
      accountId: "acc_buyer",
      id: "scs_1",
      setupReferenceId: "scs_1",
      status: "requires-action",
      url: "https://checkout.stripe.test/setup/scs_1",
      consentText: "Save this card for future purchases.",
    });
    expect(JSON.stringify(body)).not.toContain(setupSessionRow.processor_client_secret);
    expect(fakeServices.createSavedCheckoutSetupSession).toHaveBeenCalledTimes(1);
    expect(fakeServices.createSavedCheckoutSetupSession).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        attemptId: setupAttemptKey,
        evidenceWindow: null,
        returnUrlBase: "https://app.chasesets.test",
        returnUrlPath: "/account/payment-methods",
        agentGrantId: null,
      },
      expect.objectContaining({ tenantId: managingActor.tenantId }),
    );
    expect(harness.currentOpenWindow).toHaveBeenCalledTimes(1);
    // The owner attempt replaces the platform-TTL reservation: nothing is reserved or completed there.
    expect(harness.idempotencyStore.reserve).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.complete).not.toHaveBeenCalled();
    expect(harness.acquire).toHaveBeenCalledTimes(1);
    expect(harness.release).toHaveBeenCalledTimes(1);
    expect(harness.records.map((record) => record.outcome)).toEqual(["allowed"]);
  });

  it("J3 refuses governed raw credentials before the MCP idempotency hash, audit and output sinks", async () => {
    const fakeServices = setupServices();
    const handlers = createPaymentMcpHandlers(fakeServices, {
      currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
    });
    const reserve = vi.fn<McpIdempotencyStore["reserve"]>(async () => {
      throw new Error("Synthetic forbidden pre-admission persistence");
    });
    const records: McpAuditRecord[] = [];
    const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
    app.use("*", async (context, next) => {
      context.set("actor", managingActor);
      await next();
    });
    app.route(
      "/",
      createMcpRoutes({
        ...handlers,
        audit: (record) => {
          records.push(record);
        },
        idempotencyStore: { reserve, get: vi.fn(() => null), put: vi.fn(), complete: vi.fn(), abandon: vi.fn() },
      }),
    );
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "SYNTHETIC_REQUEST",
        method: "tools/call",
        params: {
          name: "payments.start-payment-method-setup",
          arguments: {
            accountId: managingActor.accountId,
            returnUrl:
              "https://SYNTHETIC_REJECTED@marketplace.staging.chasesets.com/account/payment-methods#SYNTHETIC_REJECTED",
            idempotencyKey: setupAttemptKey,
            confirmationText: "Start Payment Method Setup.",
          },
          confirmation: { confirmed: true, text: "Start Payment Method Setup." },
        },
      }),
    });
    const output = await response.text();
    expect(output).toContain("evidence-window-provider-write:unsafe-material");
    expect(reserve).not.toHaveBeenCalled();
    expect(fakeServices.createSavedCheckoutSetupSession).not.toHaveBeenCalled();
    expect(JSON.stringify({ records, output })).not.toContain("SYNTHETIC_REJECTED");
  });

  it("returns the hosted setup URL and never exposes the processor client secret", async () => {
    const fakeServices = setupServices();
    const handlers = createPaymentMcpHandlers(fakeServices);

    const result = (await handlers.toolHandlers["payments.start-payment-method-setup"]?.(
      mcpRequest(
        {
          accountId: "acc_buyer",
          returnUrl: "https://app.chasesets.test/account/payment-methods",
          idempotencyKey: setupAttemptKey,
          confirmationText: "Save my card",
        },
        managingActor,
      ),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      accountId: "acc_buyer",
      setupReferenceId: "scs_1",
      url: "https://checkout.stripe.test/setup/scs_1",
      status: "requires-action",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain(setupSessionRow.processor_client_secret);
  });

  it("passes the buyer return URL origin and path through to the setup session", async () => {
    const fakeServices = setupServices();
    const handlers = createPaymentMcpHandlers(fakeServices);

    await handlers.toolHandlers["payments.start-payment-method-setup"]?.(
      mcpRequest(
        {
          accountId: "acc_buyer",
          returnUrl: "https://app.chasesets.test/account/payment-methods?ref=1",
          idempotencyKey: setupAttemptKey,
          confirmationText: "Save my card",
        },
        managingActor,
      ),
    );

    expect(fakeServices.createSavedCheckoutSetupSession).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        attemptId: setupAttemptKey,
        returnUrlBase: "https://app.chasesets.test",
        returnUrlPath: "/account/payment-methods?ref=1",
        agentGrantId: null,
      },
      expect.objectContaining({ tenantId: managingActor.tenantId }),
    );
  });

  it("tags agent-created setup sessions with the agent grant id", async () => {
    const fakeServices = setupServices();
    const handlers = createPaymentMcpHandlers(fakeServices);

    await handlers.toolHandlers["payments.start-payment-method-setup"]?.(
      mcpRequest(
        {
          accountId: "acc_buyer",
          returnUrl: "https://app.chasesets.test/account/payment-methods",
          idempotencyKey: setupAttemptKey,
        },
        {
          ...managingActor,
          agentGrant: {
            grantId: "lpa_1",
            platformProfileUrl: "https://agent.example/.well-known/ucp",
            scopes: ["dev.ucp.shopping.checkout:manage"],
            rolePermissions: ["orders.manage"],
          },
        },
      ),
    );

    expect(fakeServices.createSavedCheckoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentGrantId: "lpa_1", attemptId: setupAttemptKey }),
      expect.objectContaining({ tenantId: managingActor.tenantId }),
    );
  });

  it("rejects a non-HTTPS return URL", async () => {
    const handlers = createPaymentMcpHandlers(setupServices());

    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]?.(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "http://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
            confirmationText: "Save my card",
          },
          managingActor,
        ),
      ),
    ).rejects.toThrow(/HTTPS/);
  });

  it("rejects a setup session that lacks a hosted URL rather than exposing a client secret", async () => {
    const handlers = createPaymentMcpHandlers(setupServices({ setupSession: { processor_redirect_url: null } }));

    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]?.(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "https://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
            confirmationText: "Save my card",
          },
          managingActor,
        ),
      ),
    ).rejects.toThrow(/hosted payment-method setup URL/);
  });

  it("rejects a non-HTTPS hosted setup URL from the processor", async () => {
    const handlers = createPaymentMcpHandlers(
      setupServices({ setupSession: { processor_redirect_url: "http://checkout.stripe.test/setup/scs_1" } }),
    );

    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]?.(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "https://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
            confirmationText: "Save my card",
          },
          managingActor,
        ),
      ),
    ).rejects.toThrow(/hosted payment-method setup URL/);
  });

  it("enforces the orders.manage permission on setup", async () => {
    const handlers = createPaymentMcpHandlers(setupServices());

    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]?.(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "https://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
            confirmationText: "Save my card",
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/Missing required permission: orders.manage/);
  });

  it("confirms attachment and returns only display-safe payment-method facts", async () => {
    const handlers = createPaymentMcpHandlers(setupServices());

    const result = (await handlers.toolHandlers["payments.confirm-payment-method-setup"]?.(
      mcpRequest({ accountId: "acc_buyer", setupReferenceId: "scs_1" }, managingActor),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      accountId: "acc_buyer",
      attached: true,
      status: "attached",
      paymentMethod: { instrumentId: "sci_1", displayLabel: "Visa ····4242", isDefault: true },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(readyInstrumentRow.provider_reference);
    expect(serialized).not.toContain(readyInstrumentRow.provider_fingerprint);
  });

  it("reports a pending status while the buyer has not finished the hosted hop", async () => {
    const handlers = createPaymentMcpHandlers(setupServices({ reconcileResult: null }));

    await expect(
      handlers.toolHandlers["payments.confirm-payment-method-setup"]?.(
        mcpRequest({ accountId: "acc_buyer", setupReferenceId: "scs_1" }, managingActor),
      ),
    ).resolves.toMatchObject({ attached: false, status: "pending", paymentMethod: null });
  });

  it("enforces the orders.manage permission on confirmation", async () => {
    const handlers = createPaymentMcpHandlers(setupServices());

    await expect(
      handlers.toolHandlers["payments.confirm-payment-method-setup"]?.(
        mcpRequest({ accountId: "acc_buyer", setupReferenceId: "scs_1" }, actor),
      ),
    ).rejects.toThrow(/Missing required permission: orders.manage/);
  });
});

/**
 * A real Payments runtime (in-memory event store, minimal row store) behind the MCP handlers, so
 * replay and conflict come from the shipped Saved Checkout Instrument Attempt, not a fake.
 */
function attemptRuntime(createSetupSession: PaymentProcessorGateway["createSetupSession"]) {
  const customers = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO payments_provider_customers")) {
        const row = { account_id: params[0], provider: params[1], provider_customer_reference: params[2] };
        customers.set(String(params[0]), row);
        return { rows: [row] };
      }
      if (sql.includes("FROM payments_provider_customers"))
        return { rows: [customers.get(String(params[0]))].filter(Boolean) };
      if (sql.includes("INSERT INTO payments_saved_checkout_setup_sessions")) {
        const row = {
          ...setupSessionRow,
          setup_reference_id: params[0],
          account_id: params[1],
          agent_grant_id: params[2],
          processor_setup_reference: params[5],
          processor_client_secret: params[6],
          processor_redirect_url: params[7],
          processor_status: params[8],
        };
        sessions.set(String(params[0]), row);
        return { rows: [row] };
      }
      if (sql.includes("FROM payments_saved_checkout_setup_sessions") && sql.includes("setup_reference_id = $1")) {
        return { rows: [sessions.get(String(params[0]))].filter(Boolean) };
      }
      return { rows: [] };
    },
  };
  const processorGateway = {
    ...createFakePaymentProcessorGateway(),
    createSetupSession: vi.fn(createSetupSession),
  };
  const { eventStore } = createInMemoryEventStore();
  const runtime = createPaymentRuntime({
    // The setup command never reads declines or runs a webhook or default-change transaction.
    cardDeclineStore: { check: async () => null, record: async () => undefined },
    runWebhookTransaction: async () => {
      throw new Error("Webhooks are not part of this test.");
    },
    runPaymentTransaction: async () => {
      throw new Error("Default changes are not part of this test.");
    },
    eventStore,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    db: db as never,
    processorGateway,
  });
  return { runtime, processorGateway, eventStore, db };
}

const hostedSetup = (reference: string) => ({
  processorName: "stripe" as const,
  processorSetupKind: "checkout-setup-session" as const,
  processorSetupReference: reference,
  processorClientSecret: "SYNTHETIC_CLIENT_SECRET",
  processorRedirectUrl: `https://checkout.stripe.test/${reference}`,
  processorStatus: "open",
});

describe("issue-10014 AC4 owner-authoritative start-payment-method-setup", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["platform-style", "idem_setup_1"],
    ["uppercase", setupAttemptKey.toUpperCase()],
    ["UUIDv1", "3f2b8c1e-6a4d-1e9b-b7c2-1d0e5f6a7b81"],
  ])(
    "refuses a %s key in an open window before admission, reservation, lease, services and audit leakage",
    async (_label, idempotencyKey) => {
      const fakeServices = setupServices();
      const harness = setupRouteHarness(fakeServices, {
        window: { windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" },
      });

      const body = await harness.call({ idempotencyKey });

      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain("https://checkout.stripe.test");
      expect(harness.currentOpenWindow).not.toHaveBeenCalled();
      expect(harness.idempotencyStore.reserve).not.toHaveBeenCalled();
      expect(harness.acquire).not.toHaveBeenCalled();
      expect(fakeServices.createSavedCheckoutSetupSession).not.toHaveBeenCalled();
      expect(harness.records).toEqual([expect.objectContaining({ outcome: "denied" })]);
      if (idempotencyKey) expect(JSON.stringify(harness.records)).not.toContain(idempotencyKey);
    },
  );

  it("replays a lost response, also for an equivalent returnUrl, as the same hosted URL without a second setup", async () => {
    const { runtime, processorGateway } = attemptRuntime(async () => hostedSetup("cs_SYNTHETIC_FIRST"));
    const harness = setupRouteHarness(runtime);

    const first = await harness.call({});
    const replay = await harness.call({ returnUrl: "https://APP.chasesets.test:443/account/./payment-methods#lost" });

    expect(first.result.isError).toBeUndefined();
    expect(replay.result.structuredContent).toEqual(first.result.structuredContent);
    expect((first.result.structuredContent as { url: string }).url).toBe(
      "https://checkout.stripe.test/cs_SYNTHETIC_FIRST",
    );
    expect(processorGateway.createSetupSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ first, replay, records: harness.records })).not.toContain("SYNTHETIC_CLIENT_SECRET");
  });

  it("answers a crashed setup with a closed unconfirmed error on every replay, never a second setup", async () => {
    const { runtime, processorGateway } = attemptRuntime(async () => {
      throw new Error("SYNTHETIC_PRIVATE_PROCESSOR_TIMEOUT");
    });
    const harness = setupRouteHarness(runtime);

    const crashed = await harness.call({});
    const replay = await harness.call({});

    for (const body of [crashed, replay]) {
      expect(body.result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "The saved payment method request could not be confirmed. Check again with the same request.",
          },
        ],
      });
    }
    expect(processorGateway.createSetupSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ crashed, replay, records: harness.records })).not.toContain("SYNTHETIC_PRIVATE");
  });

  type Runtime = ReturnType<typeof attemptRuntime>;
  const unconfirmedResult = {
    isError: true,
    content: [
      {
        type: "text",
        text: "The saved payment method request could not be confirmed. Check again with the same request.",
      },
    ],
  };
  /** Fails the `n`th append to the attempt stream once, before it writes or after it committed. */
  const failAttemptAppend =
    (n: number, timing: "before" | "after") =>
    ({ eventStore }: Runtime) => {
      const append = eventStore.appendToStream;
      let appends = 0;
      Object.assign(eventStore, {
        appendToStream: async (input: Parameters<typeof append>[0]) => {
          if (!input.streamId.startsWith("payments.saved-checkout-instrument-attempt-") || ++appends !== n) {
            return append(input);
          }
          if (timing === "after") await append(input);
          throw new Error("SYNTHETIC_PRIVATE_STORAGE_DETAIL");
        },
      });
    };
  /** Fails the next statement containing `fragment` once. */
  const failStatement =
    (fragment: string) =>
    ({ db }: Runtime) => {
      const query = db.query;
      let failed = false;
      db.query = async (sql, params) => {
        if (failed || !sql.includes(fragment)) return query(sql, params);
        failed = true;
        throw new Error("SYNTHETIC_PRIVATE_STORAGE_DETAIL");
      };
    };

  it.each<readonly [string, (runtime: Runtime) => void, number, readonly ("hosted" | "unconfirmed")[], number]>([
    ["the started append before it commits", failAttemptAppend(1, "before"), 1, ["unconfirmed", "hosted", "hosted"], 1],
    [
      "the started append after it committed",
      failAttemptAppend(1, "after"),
      1,
      ["unconfirmed", "unconfirmed", "unconfirmed"],
      0,
    ],
    [
      "the setup row write after the send",
      failStatement("INSERT INTO payments_saved_checkout_setup_sessions"),
      1,
      ["unconfirmed", "unconfirmed", "unconfirmed"],
      1,
    ],
    [
      "the replay lookup",
      failStatement("FROM payments_saved_checkout_setup_sessions"),
      2,
      ["hosted", "unconfirmed", "hosted"],
      1,
    ],
    ["the completion append", failAttemptAppend(2, "before"), 1, ["unconfirmed", "hosted", "hosted"], 1],
  ])(
    "closes a failure of %s as unconfirmed with no private text and no second setup",
    async (_label, inject, failBeforeCall, outcomes, setups) => {
      const runtime = attemptRuntime(async () => hostedSetup("cs_SYNTHETIC_ONCE"));
      const harness = setupRouteHarness(runtime.runtime);

      const bodies = [];
      for (const call of [1, 2, 3]) {
        if (call === failBeforeCall) inject(runtime);
        bodies.push(await harness.call({}));
      }

      expect(
        bodies.map((body) =>
          JSON.stringify(body.result) === JSON.stringify(unconfirmedResult)
            ? "unconfirmed"
            : (body.result.structuredContent as { url?: string } | undefined)?.url ===
                "https://checkout.stripe.test/cs_SYNTHETIC_ONCE"
              ? "hosted"
              : body.result,
        ),
      ).toEqual(outcomes);
      expect(runtime.processorGateway.createSetupSession).toHaveBeenCalledTimes(setups);
      expect(JSON.stringify({ bodies, records: harness.records })).not.toContain("SYNTHETIC_PRIVATE");
      expect(JSON.stringify({ bodies, records: harness.records })).not.toContain("SYNTHETIC_CLIENT_SECRET");
    },
  );

  it("refuses another Agent Grant's identical key on the account as attempt_conflict with no URL", async () => {
    const { runtime, processorGateway } = attemptRuntime(async () => hostedSetup("cs_SYNTHETIC_GRANT"));
    const handlers = createPaymentMcpHandlers(runtime);
    const grantActor = (grantId: string): ResolvedActor => ({
      ...managingActor,
      agentGrant: {
        grantId,
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        scopes: ["dev.ucp.shopping.checkout:manage"],
        rolePermissions: ["orders.manage"],
      },
    });
    const start = (grantId: string) =>
      handlers.toolHandlers["payments.start-payment-method-setup"]!(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "https://app.chasesets.test/account/payment-methods",
            idempotencyKey: setupAttemptKey,
          },
          grantActor(grantId),
        ),
      );

    await expect(start("lpa_SYNTHETIC_A")).resolves.toMatchObject({
      url: "https://checkout.stripe.test/cs_SYNTHETIC_GRANT",
    });
    const conflict = await Promise.resolve(start("lpa_SYNTHETIC_B")).catch((error: unknown) => error);
    expect(conflict).toMatchObject({ code: "attempt_conflict" });
    expect(JSON.stringify(conflict)).not.toContain("checkout.stripe.test");
    expect(processorGateway.createSetupSession).toHaveBeenCalledTimes(1);
  });
});
