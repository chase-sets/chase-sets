import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from "./index";
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

afterEach(() => vi.unstubAllGlobals());

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
  const input = {
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
      apiVersion: "2026-03-25.dahlia",
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
