import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPaymentCreateRejection, createStripePaymentProcessorGateway, PaymentCreateRejected } from "./index";
import { ProviderAdapterError } from "@chase-sets/http/provider-errors";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { EvidenceWindowProviderWrite } from "@chase-sets/evidence-window-provider-write";
import {
  admitGovernedPaymentInput,
  admitGovernedSetupInput,
  GOVERNED_RETURN_ORIGIN,
  providerWriteIdempotencyKey,
} from "@chase-sets/evidence-window-provider-write";
import { providerWriteDigest, validateProviderMaterial } from "@chase-sets/evidence-window-provider-write/material";
import { readFileSync } from "node:fs";
import { providerWriterShape } from "@chase-sets/evidence-window-provider-write/material";
import type { ProviderWriteRow } from "@chase-sets/evidence-window-provider-write";
import type { CreateProcessorPaymentInput, CreateProcessorSetupSessionInput } from "@chase-sets/payment-processing";
import type { PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  executeGovernedProviderWrite,
  readPaymentCreateRejection,
} from "@chase-sets/platform-runtime/evidence-window-provider-write-executor";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["12.34", "1234"],
  ["0.10", "10"],
])("converts charge and refund amounts through the money primitive: %s", async (amount, expectedMinorUnits) => {
  const calls: Array<{ url: string; amount: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const fields = new URLSearchParams(String(init?.body));
      calls.push({ url, amount: fields.get("amount") ?? fields.get("line_items[0][price_data][unit_amount]") });
      return Response.json({
        id: url.endsWith("/refunds") ? "re_SYNTHETIC" : url.endsWith("/sessions") ? "cs_SYNTHETIC" : "pi_SYNTHETIC",
        status: "succeeded",
      });
    }),
  );
  const gateway = createStripePaymentProcessorGateway({
    secretKey: "sk_test_SYNTHETIC",
    publishableKey: "pk_test_SYNTHETIC",
    webhookSecret: "whsec_SYNTHETIC",
    apiBaseUrl: "https://stripe.test",
  });
  const input: CreateProcessorPaymentInput = {
    paymentId: "pay_SYNTHETIC" as PaymentId,
    buyerAccountId: "acc_SYNTHETIC" as AccountId,
    orderIds: [],
    amount,
    currencyCode: "usd",
    paymentMethodCategory: "card",
    description: "Synthetic payment",
    providerCustomerReference: "cus_SYNTHETIC",
    returnUrl: "https://marketplace.test/account/payments/pay_SYNTHETIC",
  };

  await gateway.createPaymentSession(input);
  await gateway.createPaymentSession({
    ...input,
    savedCheckoutInstrument: {
      instrumentId: "sci_SYNTHETIC",
      providerReference: "pm_SYNTHETIC",
      confirmationExperience: "off-session-token",
    },
  });
  await gateway.createAgenticPaymentSession!({
    ...input,
    agenticPayment: {
      kind: "stripe-shared-payment-token",
      sharedPaymentGrantedToken: "spt_SYNTHETIC",
    },
  });
  await gateway.createRefund({
    refundId: "rfd_SYNTHETIC",
    paymentId: input.paymentId,
    processorPaymentReference: "pi_SYNTHETIC",
    orderIds: [],
    amount,
    currencyCode: "usd",
    reason: "Synthetic refund",
  });

  expect(calls).toEqual([
    { url: "https://stripe.test/v1/checkout/sessions", amount: expectedMinorUnits },
    { url: "https://stripe.test/v1/payment_intents", amount: expectedMinorUnits },
    { url: "https://stripe.test/v1/payment_intents", amount: expectedMinorUnits },
    { url: "https://stripe.test/v1/refunds", amount: expectedMinorUnits },
  ]);
  expect(readFileSync(new URL("./index.ts", import.meta.url), "utf8").match(/parseFloat/g)).toBeNull();
});

// Stateful journal honoring the store's full-key + expected-version CAS semantics.
function casJournal() {
  let row: ProviderWriteRow | null = null;
  const completions: string[] = [];
  const bump = (patch: Partial<ProviderWriteRow>) => (row = { ...row!, ...patch, version: row!.version + 1 });
  const port: EvidenceWindowProviderWrite = {
    async reserveOrResolve(input) {
      if (row) return { kind: "existing", row };
      const shape = providerWriterShape(input.binding);
      row = {
        key: {
          windowId: input.windowId,
          objectClass: shape.objectClass,
          creationOrdinal: 1,
          operation: shape.operation,
        },
        binding: input.binding,
        envelope: input.envelope,
        digest: await providerWriteDigest(input.envelope),
        state: "pending",
        version: 1,
        observedClass: null,
        reusedExisting: false,
        replayAttempts: 0,
        logicalSlot: shape.logicalSlot,
        providerReference: null,
        responseExpiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replayDeadline: "2099-01-01T00:00:00.000Z",
      };
      return { kind: "reserved", row };
    },
    async complete(_key, version, result) {
      if (version !== row!.version || row!.state !== "pending") {
        completions.push(`stale:${result.state}`);
        return { kind: "stale-write-rejected" };
      }
      completions.push(result.state);
      return {
        kind: "existing",
        row: bump({
          state: result.state,
          providerReference: result.state === "succeeded" ? result.providerReference : null,
          ...(result.state === "failed" && result.rejection ? { rejection: result.rejection } : {}),
        }),
      };
    },
    async claimReplay(_key, version) {
      if (version !== row!.version) return { kind: "stale-write-rejected" };
      if (row!.state !== "pending")
        return { kind: "refused", code: row!.state === "failed" ? "write-failed" : "write-unresolved" };
      if (row!.replayAttempts === 1) {
        bump({ state: "ambiguous" });
        return { kind: "refused", code: "write-unresolved" };
      }
      return { kind: "existing", row: bump({ replayAttempts: 1 }) };
    },
    observeCapture: async (_key, version) =>
      version === row!.version
        ? { kind: "existing", row: bump({ observedClass: 1 }) }
        : { kind: "stale-write-rejected" },
    observeCustomerReuse: vi.fn(),
    admitSavedResponse: vi.fn(),
    readWindow: async () => (row ? [row] : []),
  };
  return { port, current: () => row, completions };
}

// Synthetic identifiers and text, preserving the captured TEST 402 error shape.
const declined = {
  type: "card_error",
  code: "card_declined",
  message: "Synthetic card decline.",
  decline_code: "generic_decline",
  payment_intent: { id: "pi_SYNTHETIC", status: "requires_payment_method", customer: "cus_SYNTHETIC" },
};
const invalidRequest = {
  type: "invalid_request_error",
  code: "parameter_missing",
  message: "Synthetic invalid input.",
};
const rejection = {
  status: 402,
  type: "card_error",
  code: "card_declined",
  paymentIntentId: "pi_SYNTHETIC",
  paymentIntentStatus: "requires_payment_method",
};
const rejectionWindow = { windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z" };
const rejectionInput: CreateProcessorPaymentInput = {
  paymentId: "pay_SYNTHETIC" as PaymentId,
  buyerAccountId: "acc_SYNTHETIC" as AccountId,
  orderIds: [],
  amount: "1.00",
  currencyCode: "usd",
  paymentMethodCategory: "card",
  description: "Synthetic payment",
  providerCustomerReference: "cus_SYNTHETIC",
  returnUrl: `${GOVERNED_RETURN_ORIGIN}/account/payments/pay_SYNTHETIC`,
};
const rejectionInputs = [
  { kind: "Checkout", input: rejectionInput },
  {
    kind: "saved PaymentIntent",
    input: {
      ...rejectionInput,
      savedCheckoutInstrument: {
        instrumentId: "sci_SYNTHETIC",
        providerReference: "pm_SYNTHETIC",
        confirmationExperience: "off-session-token",
      },
    },
  },
] satisfies ReadonlyArray<{ kind: string; input: CreateProcessorPaymentInput }>;

function rejectionGateway(journal?: EvidenceWindowProviderWrite) {
  return createStripePaymentProcessorGateway({
    secretKey: journal ? "sk_test_SYNTHETIC" : "sk_live_SYNTHETIC",
    publishableKey: journal ? "pk_test_SYNTHETIC" : "pk_live_SYNTHETIC",
    webhookSecret: "whsec_SYNTHETIC",
    apiBaseUrl: "https://stripe.test",
    ...(journal && {
      evidenceWindowCorrelation: { currentOpenWindow: async () => rejectionWindow },
      evidenceWindowProviderWrite: journal,
    }),
  });
}

it.each([
  { name: "captured shape", status: 402, body: { error: declined }, expected: rejection },
  { name: "400 with no PI", status: 400, body: { error: invalidRequest } },
  { name: "400 with PI", status: 400, body: { error: { ...declined, ...invalidRequest } } },
  { name: "400 with otherwise matching body", status: 400, body: { error: declined } },
  { name: "idempotency error", status: 402, body: { error: { ...declined, type: "idempotency_error" } } },
  { name: "other 402 type", status: 402, body: { error: { ...declined, type: "api_error" } } },
  { name: "missing PI", status: 402, body: { error: { ...declined, payment_intent: undefined } } },
  { name: "expanded PI required", status: 402, body: { error: { ...declined, payment_intent: "pi_SYNTHETIC" } } },
  { name: "malformed JSON", status: 402, body: "{not json" },
  ...["processing", "requires_action", "succeeded", null].map((status) => ({
    name: `PI state ${status}`,
    status: 402,
    body: { error: { ...declined, payment_intent: { ...declined.payment_intent, status } } },
  })),
  ...["pi_", "pm_SYNTHETIC", "pi_SYNTHETIC_secret_SYNTHETIC", "pi_BAD/ID", "pi_TRAILING\n"].map((id) => ({
    name: `malformed PI id ${JSON.stringify(id)}`,
    status: 402,
    body: { error: { ...declined, payment_intent: { ...declined.payment_intent, id } } },
  })),
  ...[401, 403, 404, 409, 429, 500].map((status) => ({ name: String(status), status, body: { error: declined } })),
] as ReadonlyArray<{ name: string; status: number; body: unknown; expected?: typeof rejection }>)(
  "payment-create-rejection-classifier: $name",
  ({ status, body, expected }) => {
    expect(classifyPaymentCreateRejection(status, body)).toEqual(expected ?? null);
  },
);

it.each(rejectionInputs)("payment-create-rejection-same-on-both-paths: $kind", async ({ input }) => {
  const fetch = vi.fn(async () => Response.json({ error: declined }, { status: 402 }));
  vi.stubGlobal("fetch", fetch);
  const journal = casJournal();

  await expect.soft(rejectionGateway().createPaymentSession(input)).rejects.toMatchObject({
    name: "PaymentCreateRejected",
    rejection,
  });
  await expect.soft(rejectionGateway(journal.port).createPaymentSession(input)).rejects.toMatchObject({
    name: "PaymentCreateRejected",
    message: "Payment create was rejected by the provider.",
    rejection,
  });
  expect(journal.current()).toMatchObject({ state: "failed", rejection, replayAttempts: 0 });
  expect(journal.completions).toEqual(["failed"]);

  const wireKey = providerWriteIdempotencyKey(journal.current()!.key);
  await expect(rejectionGateway(journal.port).createPaymentSession(input)).rejects.toMatchObject({
    name: "PaymentCreateRejected",
    rejection,
  });
  await expect(readPaymentCreateRejection(journal.port, wireKey)).resolves.toEqual(rejection);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(journal.current()).toMatchObject({ replayAttempts: 0, version: 2 });
});

it("payment-create-rejection lookup only reads an exact failed wire key", async () => {
  const key = { windowId: rejectionWindow.windowId, objectClass: 2, creationOrdinal: 1, operation: "create" } as const;
  const wireKey = providerWriteIdempotencyKey(key);
  const readWindow = vi.fn().mockResolvedValue([{ key, state: "failed", rejection }]);
  const journal = { ...casJournal().port, readWindow };

  await expect(readPaymentCreateRejection(journal, `${wireKey}:`)).resolves.toBeNull();
  await expect(readPaymentCreateRejection(journal, wireKey.replace(":2:1:", ":2:01:"))).resolves.toBeNull();
  expect(readWindow).not.toHaveBeenCalled();

  await expect(readPaymentCreateRejection(journal, wireKey.replace(":2:1:", ":4:1:"))).resolves.toBeNull();
  await expect(readPaymentCreateRejection(journal, wireKey.replace(":2:1:", ":2:2:"))).resolves.toBeNull();
  await expect(readPaymentCreateRejection(journal, wireKey.replace(":create", ":dispose"))).resolves.toBeNull();
  await expect(readPaymentCreateRejection(journal, wireKey)).resolves.toEqual(rejection);
  expect(readWindow).toHaveBeenLastCalledWith(key.windowId);
  readWindow.mockResolvedValue([{ key, state: "failed" }]);
  await expect(readPaymentCreateRejection(journal, wireKey)).resolves.toBeNull();
});

it.each(rejectionInputs)("uncertain payment-create 4xx keeps the same key replayable: $kind", async ({ input }) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ error: invalidRequest }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetch);
  const journal = casJournal();
  const create = () => rejectionGateway(journal.port).createPaymentSession(input);
  await expect(create()).rejects.toMatchObject({ code: "write-unresolved" });
  expect(journal.current()).toMatchObject({ state: "pending", replayAttempts: 0 });
  await expect(create()).rejects.toMatchObject({ code: "write-unresolved" });
  expect(journal.current()).toMatchObject({ state: "pending", replayAttempts: 1 });
  await expect(create()).rejects.toMatchObject({ code: "write-unresolved" });
  expect(journal.current()).toMatchObject({ state: "ambiguous", replayAttempts: 1 });
  expect(journal.completions).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
  const keys = fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("Idempotency-Key"));
  expect(keys).toEqual(Array(2).fill(providerWriteIdempotencyKey(journal.current()!.key)));
});

it.each([
  {
    status: 402,
    error: { ...declined, message: "Synthetic decline: insufficient balance." },
    category: "balance_insufficient",
  },
  { status: 400, error: invalidRequest, category: "configuration" },
] as const)("payment-create-rejection-direct-parity: $status", async ({ status, error, category }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error }, { status })),
  );
  const gateway = rejectionGateway();
  const baseline = new ProviderAdapterError(category, error.message, status);
  const agenticPayment = { kind: "stripe-shared-payment-token", sharedPaymentGrantedToken: "spt_SYNTHETIC" } as const;
  for (const [kind, create, typed] of [
    ...rejectionInputs.map(
      ({ kind, input }) => [kind, () => gateway.createPaymentSession(input), status === 402] as const,
    ),
    ["wallet funding", () => gateway.createPaymentSession({ ...rejectionInput, purpose: "wallet-funding" }), false],
    ["agentic", () => gateway.createAgenticPaymentSession!({ ...rejectionInput, agenticPayment }), false],
  ] as const) {
    const actual = await create().catch((failure: unknown) => failure);
    expect(actual).toBeInstanceOf(ProviderAdapterError);
    expect(actual).toMatchObject({
      category: baseline.category,
      providerStatus: baseline.providerStatus,
      message: baseline.message,
    });
    expect(actual).not.toHaveProperty("code");
    expect
      .soft((actual as ProviderAdapterError).constructor, kind)
      .toBe(typed ? PaymentCreateRejected : ProviderAdapterError);
  }
});

it("J4 a concurrent same-key replay answered 409 idempotency_key_in_use stays pending, then ambiguous, never failed", async () => {
  const journal = casJournal();
  let release!: () => void;
  let entered!: () => void;
  const firstInFlight = new Promise<void>((resolve) => (entered = resolve));
  const releaseFirst = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (++posts === 1) {
        entered();
        await releaseFirst;
        // Provider created and confirmed the PaymentIntent (money moved).
        return Response.json({ id: "pi_SYNTHETIC_CHARGED", status: "succeeded" });
      }
      // Stripe's documented answer to a second request that reuses an in-progress Idempotency-Key.
      return Response.json(
        {
          error: {
            type: "idempotency_error",
            code: "idempotency_key_in_use",
            message: "There is currently another in-progress request using this Idempotent Key.",
          },
        },
        { status: 409 },
      );
    }),
  );
  const gateway = createStripePaymentProcessorGateway({
    secretKey: "sk_test_SYNTHETIC",
    publishableKey: "pk_test_SYNTHETIC",
    webhookSecret: "whsec_SYNTHETIC",
    evidenceWindowCorrelation: {
      currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
    },
    evidenceWindowProviderWrite: journal.port,
  });
  const input: CreateProcessorPaymentInput = {
    paymentId: "pay_SYNTHETIC" as PaymentId,
    buyerAccountId: "acc_SYNTHETIC" as AccountId,
    orderIds: [],
    amount: "12.34",
    currencyCode: "usd",
    paymentMethodCategory: "card" as const,
    description: "Synthetic saved payment",
    providerCustomerReference: "cus_SYNTHETIC",
    savedCheckoutInstrument: {
      instrumentId: "sci_SYNTHETIC",
      providerReference: "pm_SYNTHETIC",
      confirmationExperience: "off-session-token" as const,
    },
  };
  const tabA = gateway.createPaymentSession(input).then(
    () => "ok",
    (error: Error) => error.message,
  );
  await firstInFlight;
  const tabB = await gateway.createPaymentSession(input).then(
    () => "ok",
    (error: Error) => error.message,
  );
  release();
  const a = await tabA;
  expect(posts).toBe(2);
  expect(tabB).toBe("evidence-window-provider-write:write-unresolved");
  expect(a).toBe("evidence-window-provider-write:stale-write-rejected");
  expect(journal.completions).toEqual(["stale:succeeded"]);
  expect(journal.current()).toMatchObject({ state: "pending", providerReference: null, replayAttempts: 1, version: 2 });
  await expect(gateway.createPaymentSession(input)).rejects.toThrow("evidence-window-provider-write:write-unresolved");
  expect(posts).toBe(2);
  expect(journal.current()).toMatchObject({
    state: "ambiguous",
    providerReference: null,
    replayAttempts: 1,
    version: 3,
  });
});

function recordingJournal() {
  let row: ProviderWriteRow | null = null;
  const port: EvidenceWindowProviderWrite = {
    reserveOrResolve: vi.fn<EvidenceWindowProviderWrite["reserveOrResolve"]>(async (input) => {
      const shape = providerWriterShape(input.binding);
      row = {
        key: {
          windowId: input.windowId,
          objectClass: shape.objectClass,
          creationOrdinal: 1,
          operation: shape.operation,
        },
        binding: input.binding,
        envelope: input.envelope,
        digest: await providerWriteDigest(input.envelope),
        state: "pending",
        version: 1,
        observedClass: null,
        reusedExisting: false,
        replayAttempts: 0,
        logicalSlot: shape.logicalSlot,
        providerReference: null,
        responseExpiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replayDeadline: "2099-01-01T00:00:00.000Z",
      };
      return { kind: "reserved", row };
    }),
    complete: vi.fn<EvidenceWindowProviderWrite["complete"]>(async (key, version, result) => {
      expect(key).toEqual(row!.key);
      expect(version).toBe(row!.version);
      row = {
        ...row!,
        state: result.state,
        version: version + 1,
        providerReference: result.state === "succeeded" ? result.providerReference : null,
      };
      return { kind: "existing", row };
    }),
    observeCapture: vi.fn(),
    observeCustomerReuse: vi.fn(),
    claimReplay: vi.fn(),
    admitSavedResponse: vi.fn(),
    readWindow: vi.fn(async () => (row ? [row] : [])),
  };
  return { port, current: () => row };
}

describe("governed provider writes", () => {
  it.each(["card", "bank-account"] as const)(
    "admits only the Endive %s eligibility set",
    async (paymentMethodCategory) => {
      const journal = recordingJournal();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ id: "cs_SYNTHETIC", status: "open" })),
      );
      const gateway = createStripePaymentProcessorGateway({
        secretKey: "sk_test_SYNTHETIC",
        publishableKey: "pk_test_SYNTHETIC",
        webhookSecret: "whsec_SYNTHETIC",
        evidenceWindowCorrelation: {
          currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
        },
        evidenceWindowProviderWrite: journal.port,
      });
      await gateway.createPaymentSession({
        paymentId: "pay_SYNTHETIC",
        buyerAccountId: "acc_SYNTHETIC",
        orderIds: [],
        amount: "12.34",
        currencyCode: "usd",
        paymentMethodCategory,
        description: "Synthetic Endive admission",
        returnUrl: `${GOVERNED_RETURN_ORIGIN}/checkout/payments/pay_SYNTHETIC`,
      });
      const row = journal.current()!;
      expect(row.envelope!.apiVersion).toBe("2026-10-28.endive");
      const fields = new URLSearchParams(row.envelope!.bodyText!);
      expect(fields.get("allowed_payment_method_types[0]")).toBe(
        paymentMethodCategory === "card" ? "card" : "us_bank_account",
      );
      expect(fields.get("allowed_payment_method_types[1]")).toBe(paymentMethodCategory === "card" ? "link" : null);
      expect(() => validateProviderMaterial(row.binding, row.envelope!)).not.toThrow();
      for (const mutation of [
        "removed parameter",
        "unsupported method",
        "bank plus Link",
        "extra index",
        "missing required type",
      ]) {
        const changed = new URLSearchParams(fields);
        if (mutation === "removed parameter") changed.set("payment_method_types[0]", "card");
        if (mutation === "unsupported method") changed.set("allowed_payment_method_types[0]", "klarna");
        if (mutation === "bank plus Link") {
          changed.set("allowed_payment_method_types[0]", "us_bank_account");
          changed.set("allowed_payment_method_types[1]", "link");
        }
        if (mutation === "extra index") changed.set("allowed_payment_method_types[2]", "link");
        if (mutation === "missing required type") changed.delete("allowed_payment_method_types[0]");
        expect(
          () => validateProviderMaterial(row.binding, { ...row.envelope!, bodyText: changed.toString() }),
          mutation,
        ).toThrow("unsafe-material");
      }
    },
  );
  it.each<{ variant: string; options: readonly (readonly [string, string])[]; accepted: boolean }>([
    {
      variant: "top-level",
      options: [["payment_method_options[card][request_three_d_secure]", "any"]],
      accepted: true,
    },
    {
      variant: "nested",
      options: [["payment_intent_data[payment_method_options][card][request_three_d_secure]", "any"]],
      accepted: false,
    },
    {
      variant: "both forms",
      options: [
        ["payment_method_options[card][request_three_d_secure]", "any"],
        ["payment_intent_data[payment_method_options][card][request_three_d_secure]", "any"],
      ],
      accepted: false,
    },
    ...["automatic", "challenge", ""].map((value) => ({
      variant: `non-any ${JSON.stringify(value)}`,
      options: [["payment_method_options[card][request_three_d_secure]", value]] as const,
      accepted: false,
    })),
    {
      variant: "other ancestry",
      options: [["payment_method_options[request_three_d_secure]", "any"]],
      accepted: false,
    },
    {
      variant: "duplicate top-level",
      options: [
        ["payment_method_options[card][request_three_d_secure]", "any"],
        ["payment_method_options[card][request_three_d_secure]", "any"],
      ],
      accepted: false,
    },
  ])("governed Checkout admission accepts only top-level 3DS placement: $variant", async ({ options, accepted }) => {
    const journal = recordingJournal();
    const fetch = vi.fn(async () => Response.json({ id: "cs_SYNTHETIC", status: "open" }));
    vi.stubGlobal("fetch", fetch);
    const governance = {
      evidenceWindowCorrelation: {
        currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
      },
      evidenceWindowProviderWrite: journal.port,
    };
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test_SYNTHETIC",
      publishableKey: "pk_test_SYNTHETIC",
      webhookSecret: "whsec_SYNTHETIC",
      ...governance,
    });
    await gateway.createPaymentSession({
      paymentId: "pay_SYNTHETIC" as PaymentId,
      buyerAccountId: "acc_SYNTHETIC" as AccountId,
      orderIds: [],
      amount: "250.00",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Synthetic Checkout admission",
      returnUrl: `${GOVERNED_RETURN_ORIGIN}/checkout/payments/pay_SYNTHETIC`,
    });
    const row = journal.current()!;
    expect(row.binding.writerKind).toBe("payment-checkout");
    const fields = new URLSearchParams(row.envelope!.bodyText!);
    expect([...fields.keys()].some((name) => name.includes("request_three_d_secure"))).toBe(false);
    for (const [name, value] of options) fields.append(name, value);
    const envelope = { ...row.envelope!, bodyText: fields.toString() };
    const nextJournal = recordingJournal();
    const send = vi.fn(async () => ({ id: "cs_SYNTHETIC" }));
    const execute = () =>
      executeGovernedProviderWrite(
        { ...governance, evidenceWindowProviderWrite: nextJournal.port },
        {
          binding: row.binding,
          envelope,
          send,
          retrieve: vi.fn(),
          response: (result) => ({ reference: result.id }),
          definitiveFailure: () => false,
        },
      );
    if (accepted) {
      expect(() => validateProviderMaterial(row.binding, envelope)).not.toThrow();
      await expect(execute()).resolves.toEqual({ id: "cs_SYNTHETIC" });
      expect(nextJournal.port.reserveOrResolve).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(envelope, providerWriteIdempotencyKey(nextJournal.current()!.key));
    } else {
      expect(() => validateProviderMaterial(row.binding, envelope)).toThrow("unsafe-material");
      await expect(execute()).rejects.toMatchObject({ code: "unsafe-material" });
      expect(nextJournal.port.reserveOrResolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["embedded", "hosted"] as const)(
    "J1/J3 the %s setup mapper commits consent and sends stored wire bytes",
    async (uiMode) => {
      const journal = recordingJournal();
      const input: CreateProcessorSetupSessionInput = {
        accountId: "acc_SYNTHETIC" as AccountId,
        providerCustomerReference: "cus_SYNTHETIC",
        currencyCode: "usd",
        uiMode,
        consentId: "consent_SYNTHETIC",
        consentText: "Synthetic consent & exact escaping",
        setupReferenceId: "scs_SYNTHETIC",
        ...(uiMode === "hosted"
          ? { returnUrl: `${GOVERNED_RETURN_ORIGIN}/account/payment-methods?setupReferenceId=scs_SYNTHETIC` }
          : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const row = journal.current()!;
          expect(row.state).toBe("pending");
          expect(init.body).toBe(row.envelope!.bodyText);
          const fields = new URLSearchParams(String(init.body));
          expect(fields.get("metadata[saved_payment_consent_text]")).toBe(input.consentText);
          expect(row.binding.logicalOperationId).toBe("scs_SYNTHETIC");
          expect(new Headers(init.headers).get("Idempotency-Key")).toBe(providerWriteIdempotencyKey(row.key));
          return Response.json({ id: uiMode === "embedded" ? "seti_SYNTHETIC" : "cs_SYNTHETIC", status: "open" });
        }),
      );
      const gateway = createStripePaymentProcessorGateway({
        secretKey: "sk_test_SYNTHETIC",
        publishableKey: "pk_test_SYNTHETIC",
        webhookSecret: "whsec_SYNTHETIC",
        evidenceWindowCorrelation: {
          currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
        },
        evidenceWindowProviderWrite: journal.port,
      });
      await gateway.createSetupSession(input);
      expect(journal.current()!.state).toBe("succeeded");
    },
  );

  it.each(["saved", "checkout", "checkout-save"] as const)(
    "J1/J3 %s maps all optional risk, 3DS and consent branches without changing bytes",
    async (branch) => {
      const journal = recordingJournal();
      const input: CreateProcessorPaymentInput = {
        paymentId: "pay_SYNTHETIC" as PaymentId,
        buyerAccountId: "acc_SYNTHETIC" as AccountId,
        orderIds: [],
        amount: "12.34",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Synthetic payment & wire",
        providerCustomerReference: "cus_SYNTHETIC",
        returnUrl: `${GOVERNED_RETURN_ORIGIN}/checkout/payments/pay_SYNTHETIC`,
        cardAuthentication: { requestThreeDSecure: "any", reasonCodes: ["high-dollar", "synthetic-risk"] },
        clientRiskContext: { ipAddress: "192.0.2.1", userAgent: "SYNTHETIC_USER_AGENT" },
        marketplaceRiskMetadata: {
          seller_account_ids: "acc_SELLER",
          seller_account_count: 1,
          max_seller_order_amount: "12.34",
          high_dollar_order: false,
          fulfillment_required: true,
        },
        ...(branch === "saved"
          ? {
              savedCheckoutInstrument: {
                instrumentId: "sci_SYNTHETIC",
                providerReference: "pm_SYNTHETIC",
                confirmationExperience: "off-session-token" as const,
              },
            }
          : {}),
        ...(branch === "checkout-save"
          ? {
              savePaymentMethod: {
                providerCustomerReference: "cus_SYNTHETIC",
                consentId: "consent_SYNTHETIC",
                consentText: "Synthetic consent",
              },
            }
          : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const row = journal.current()!;
          expect(row.state).toBe("pending");
          expect(init.body).toBe(row.envelope!.bodyText);
          expect(row.digest).toBe(await providerWriteDigest(row.envelope!));
          expect(String(init.body)).not.toContain("SYNTHETIC_USER_AGENT");
          expect(String(init.body)).not.toContain("192.0.2.1");
          expect(new Headers(init.headers).get("Idempotency-Key")).toBe(providerWriteIdempotencyKey(row.key));
          return Response.json({
            id: branch === "saved" ? "pi_SYNTHETIC" : "cs_SYNTHETIC",
            status: "requires_payment_method",
          });
        }),
      );
      const gateway = createStripePaymentProcessorGateway({
        secretKey: "sk_test_SYNTHETIC",
        publishableKey: "pk_test_SYNTHETIC",
        webhookSecret: "whsec_SYNTHETIC",
        evidenceWindowCorrelation: {
          currentOpenWindow: async () => ({ windowId: "a".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
        },
        evidenceWindowProviderWrite: journal.port,
      });
      await gateway.createPaymentSession(input);
      expect(journal.current()!.state).toBe("succeeded");
    },
  );

  const binding = {
    writerKind: "customer",
    logicalOperationId: "acc_SYNTHETIC",
    ownerAccountId: "acc_SYNTHETIC",
  } as const;
  const envelope = (bodyText: string) =>
    ({
      bodyKind: "form",
      bodyText,
      method: "POST",
      endpoint: "/v1/customers",
      target: null,
      accountScope: "platform",
      connectedAccountReference: null,
      apiVersion: STRIPE_API_VERSION,
    }) as const;

  it("J3 distinguishes body order, absent bodies and empty forms in the closed digest", async () => {
    const first = envelope("name=Synthetic&metadata%5Baccount_id%5D=acc_SYNTHETIC");
    const reordered = envelope("metadata%5Baccount_id%5D=acc_SYNTHETIC&name=Synthetic");
    expect(() => validateProviderMaterial(binding, first)).not.toThrow();
    expect(await providerWriteDigest(first)).not.toBe(await providerWriteDigest(reordered));
    expect(await providerWriteDigest(envelope(""))).not.toBe(
      await providerWriteDigest({ ...first, bodyKind: "absent", bodyText: null }),
    );
    expect(() =>
      validateProviderMaterial(binding, { ...first, credential: "SYNTHETIC_REJECTED" } as typeof first),
    ).toThrow("unsafe-material");
  });

  it("J3 enforces inclusive UTF8 field bounds without truncation", () => {
    const body = (name: string) =>
      new URLSearchParams({ name, "metadata[account_id]": binding.ownerAccountId }).toString();
    expect(() => validateProviderMaterial(binding, envelope(body("x".repeat(1024))))).not.toThrow();
    expect(() => validateProviderMaterial(binding, envelope(body("x".repeat(1025))))).toThrow("unsafe-material");
    expect(() => validateProviderMaterial(binding, envelope(body("\u00e9".repeat(512))))).not.toThrow();
    expect(() => validateProviderMaterial(binding, envelope(body("\u00e9".repeat(513))))).toThrow("unsafe-material");
    for (const name of [
      "password",
      "authorization",
      "client_secret",
      "shared_payment_granted_token",
      "metadata[unknown]",
    ]) {
      expect(() =>
        validateProviderMaterial(
          binding,
          envelope(`${body("Synthetic")}&${encodeURIComponent(name)}=SYNTHETIC_REJECTED`),
        ),
      ).toThrow("unsafe-material");
    }
  });

  it("J3 keeps raw admission closed while admitting the existing default and payment-ID templates", () => {
    const origin = GOVERNED_RETURN_ORIGIN;
    expect(() => admitGovernedSetupInput({ returnUrlBase: origin })).not.toThrow();
    expect(() =>
      admitGovernedSetupInput({ returnUrlBase: origin, rawReturnUrl: `${origin}/account/payment-methods` }),
    ).not.toThrow();
    for (const root of ["account", "checkout"])
      for (const id of ["pay_SYNTHETIC", ":paymentId", "{paymentId}"]) {
        expect(() =>
          admitGovernedPaymentInput(
            { returnUrlBase: origin, returnUrlPath: `/${root}/payments/${id}` },
            "pay_SYNTHETIC",
          ),
        ).not.toThrow();
      }
    for (const raw of [
      `${origin}/account/payment-methods#`,
      `${origin}/account/payment-methods?`,
      ` ${origin}/account/payment-methods`,
      `https://@marketplace.staging.chasesets.com/account/payment-methods`,
      `${origin}/account/./payment-methods`,
      "x".repeat(4097),
    ]) {
      expect(() => admitGovernedSetupInput({ returnUrlBase: origin, rawReturnUrl: raw })).toThrow("unsafe-material");
    }
    expect(() => admitGovernedPaymentInput({}, "pay_SYNTHETIC")).toThrow("unsafe-material");
    expect(() =>
      admitGovernedPaymentInput(
        { returnUrlBase: origin, returnUrlPath: "/account/payments/pay_OTHER" },
        "pay_SYNTHETIC",
      ),
    ).toThrow("unsafe-material");
  });

  it("J3 pins the literal key independently of clock, target and attempt", () => {
    expect(
      providerWriteIdempotencyKey({
        windowId: "a".repeat(32),
        objectClass: 6,
        creationOrdinal: 3,
        operation: "create",
      }),
    ).toBe(`evidence-window/v1:${"a".repeat(32)}:6:3:create`);
  });

  it("J5 both manifests and both deployed factories inject the same typed port", () => {
    for (const context of ["payments", "settlement"]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../bounded-contexts/${context}/context.json`, import.meta.url), "utf8"),
      );
      expect(JSON.stringify(manifest)).toContain('"portName":"evidenceWindowProviderWrite"');
    }
    for (const deployable of ["platform-api", "platform-worker"]) {
      const source = readFileSync(new URL(`../../deployables/${deployable}/src/main.ts`, import.meta.url), "utf8");
      for (const factory of ["createStripePaymentProcessorGateway", "createStripeConnectMoneyMovementGateway"]) {
        const call = source.match(new RegExp(`${factory}\\(\\{([\\s\\S]*?)\\}\\)`));
        expect(call?.[1]).toContain("evidenceWindowCorrelation,");
        expect(call?.[1]).toContain("evidenceWindowProviderWrite,");
      }
    }
  });

  it("J1 commits the Customer request before the deployed adapter fetch", async () => {
    const reserveOrResolve = vi.fn<EvidenceWindowProviderWrite["reserveOrResolve"]>(async () => ({
      kind: "refused",
      code: "storage-failed",
    }));
    const fetch = vi.fn(async () => {
      expect(reserveOrResolve).toHaveBeenCalledTimes(1);
      return Response.json({ id: "cus_SYNTHETIC_J1" });
    });
    vi.stubGlobal("fetch", fetch);
    const governance = {
      evidenceWindowCorrelation: {
        currentOpenWindow: async () => ({ windowId: "1".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }),
      },
      evidenceWindowProviderWrite: {
        reserveOrResolve,
        complete: vi.fn(),
        observeCustomerReuse: vi.fn(),
        observeCapture: vi.fn(),
        claimReplay: vi.fn(),
        admitSavedResponse: vi.fn(),
        readWindow: vi.fn(),
      } satisfies EvidenceWindowProviderWrite,
    };
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test_SYNTHETIC",
      publishableKey: "pk_test_SYNTHETIC",
      webhookSecret: "whsec_SYNTHETIC",
      ...governance,
    });
    await expect(gateway.createCustomer({ accountId: "acct_SYNTHETIC_J1" as AccountId })).rejects.toThrow(
      "evidence-window-provider-write:storage-failed",
    );
    expect(reserveOrResolve).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
