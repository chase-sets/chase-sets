import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createPaymentMcpHandlers } from "./mcp";
import type { PaymentServices } from "./runtime";

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

describe("payment MCP stored-payment-method rail", () => {
  it("returns the hosted setup URL and never exposes the processor client secret", async () => {
    const fakeServices = setupServices();
    const handlers = createPaymentMcpHandlers(fakeServices);

    const result = (await handlers.toolHandlers["payments.start-payment-method-setup"]?.(
      mcpRequest(
        {
          accountId: "acc_buyer",
          returnUrl: "https://app.chasesets.test/account/payment-methods",
          idempotencyKey: "idem_1",
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
          idempotencyKey: "idem_1",
          confirmationText: "Save my card",
        },
        managingActor,
      ),
    );

    expect(fakeServices.createSavedCheckoutSetupSession).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      returnUrlBase: "https://app.chasesets.test",
      returnUrlPath: "/account/payment-methods?ref=1",
    });
  });

  it("rejects a non-HTTPS return URL", async () => {
    const handlers = createPaymentMcpHandlers(setupServices());

    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]?.(
        mcpRequest(
          {
            accountId: "acc_buyer",
            returnUrl: "http://app.chasesets.test/account/payment-methods",
            idempotencyKey: "idem_1",
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
            idempotencyKey: "idem_1",
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
            idempotencyKey: "idem_1",
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
            idempotencyKey: "idem_1",
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
