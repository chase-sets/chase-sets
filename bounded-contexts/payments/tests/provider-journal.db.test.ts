import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createEvidenceWindowCorrelation,
  createPostgresEvidenceWindowRegistration,
  createPostgresEvidenceWindowProviderWrite,
  platformControlPlaneSchemaSql,
} from "@chase-sets/platform-runtime/control-plane";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import {
  GOVERNED_RETURN_ORIGIN,
  providerWriteIdempotencyKey,
  requireProviderWrite,
  type EvidenceWindowProviderWrite,
  type ProviderWriteCorrelation,
  type ReserveProviderWrite,
} from "@chase-sets/evidence-window-provider-write";
import { providerWriteDigest } from "@chase-sets/evidence-window-provider-write/material";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { module as paymentsModule } from "../index";
import { createPaymentsServices } from "../support/runtime-support/services";
import { createPaymentMcpHandlers } from "../features/payments/api/mcp";

const windowId = "a".repeat(32);
const accountId = "acc_SYNTHETIC_J" as AccountId;
const paymentId = "pay_SYNTHETIC_J" as PaymentId;
const origin = GOVERNED_RETURN_ORIGIN;
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;

function customerRequest(owner = accountId): ReserveProviderWrite {
  return {
    windowId,
    binding: { writerKind: "customer", logicalOperationId: owner, ownerAccountId: owner },
    retentionSeconds: 3600,
    envelope: {
      bodyKind: "form",
      bodyText: new URLSearchParams({ name: "Synthetic Customer", "metadata[account_id]": owner }).toString(),
      method: "POST",
      endpoint: "/v1/customers",
      target: null,
      accountScope: "platform",
      connectedAccountReference: null,
      apiVersion: STRIPE_API_VERSION,
    },
  };
}

describe("deployed provider journal J1-J6 (synthetic DB proof)", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let journal: EvidenceWindowProviderWrite;
  let correlation: ProviderWriteCorrelation;
  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for provider journal DB proof.");
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["payments"], "provider_journal");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.payments.query(platformControlPlaneSchemaSql);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    const registration = createPostgresEvidenceWindowRegistration(pools.payments);
    await registration.open({ windowId, retentionSeconds: 3600 });
    correlation = createEvidenceWindowCorrelation(registration);
    journal = createPostgresEvidenceWindowProviderWrite(pools.payments);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function gateway() {
    return createStripePaymentProcessorGateway({
      secretKey: "sk_test_SYNTHETIC_J",
      publishableKey: "pk_test_SYNTHETIC_J",
      webhookSecret: "whsec_SYNTHETIC_J",
      evidenceWindowCorrelation: correlation,
      evidenceWindowProviderWrite: journal,
    });
  }
  function services() {
    return createPaymentsServices(pools.payments, {
      processorGateway: gateway(),
      evidenceWindowCorrelation: correlation,
      evidenceWindowProviderWrite: journal,
    });
  }
  function mcpInput(returnUrl: string) {
    return {
      actor: {
        sessionId: "sess_SYNTHETIC",
        tenantId: "tnt_SYNTHETIC",
        userId: "usr_SYNTHETIC",
        accountId,
        membershipId: "mem_SYNTHETIC",
        roleKey: "manager",
        permissions: ["orders.manage"],
      },
      tool: null as never,
      arguments: { accountId, returnUrl },
      request: new Request("https://api.test/mcp"),
      protocol: { protocolVersion: "2025-06-18", stateless: false, clientInfo: null, clientCapabilities: null },
    };
  }

  it("J1/J3 commits exact Customer and once-durable hosted setup bytes inside the real MCP/runtime/store/fetch seam", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const rows = await journal.readWindow(windowId);
        const row = rows.find(
          (candidate) =>
            providerWriteIdempotencyKey(candidate.key) === new Headers(init.headers).get("Idempotency-Key"),
        );
        expect(row?.state).toBe("pending");
        expect(row?.envelope?.bodyText).toBe(init.body);
        expect(row?.digest).toBe(await providerWriteDigest(row!.envelope!));
        sent.push(String(init.body));
        if (url.endsWith("customers")) return Response.json({ id: "cus_SYNTHETIC_J" });
        const fields = new URLSearchParams(String(init.body));
        const expected = `${origin}/account/payment-methods?setupReferenceId=${row!.binding.logicalOperationId}`;
        expect(fields.get("success_url")).toBe(expected);
        expect(fields.get("cancel_url")).toBe(expected);
        return Response.json({
          id: "cs_SYNTHETIC_J",
          url: "https://checkout.stripe.test/SYNTHETIC_J",
          client_secret: "SYNTHETIC_RESPONSE_SECRET",
          status: "open",
        });
      }),
    );
    const runtime = services();
    const handlers = createPaymentMcpHandlers(runtime.payments, runtime.evidenceWindowCorrelation);
    const result = await handlers.toolHandlers["payments.start-payment-method-setup"]!(
      mcpInput(`${origin}/account/payment-methods`),
    );
    const rows = await journal.readWindow(windowId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "succeeded")).toBe(true);
    expect(JSON.stringify({ rows, result, sent })).not.toContain("SYNTHETIC_RESPONSE_SECRET");
    expect(rows.find((row) => row.binding.writerKind === "setup-hosted")?.binding.logicalOperationId).toBe(
      (result as { setupReferenceId: string }).setupReferenceId,
    );
  });

  it.each([
    `https://evil.test/account/payment-methods`,
    `${origin}/account/payment-methods?setupReferenceId=scs_OTHER`,
    `${origin}/account/payment-methods?x=1&x=2`,
    `${origin}/account/payment-methods?`,
    `${origin}/account/payment-methods#`,
    `${origin}/account/payment-methods#SYNTHETIC_REJECTED`,
    `https://SYNTHETIC_REJECTED@marketplace.staging.chasesets.com/account/payment-methods`,
    `https://@marketplace.staging.chasesets.com/account/payment-methods`,
    `${origin}:443/account/payment-methods`,
    `${origin}/account/./payment-methods`,
    `${origin}/account/%70ayment-methods`,
    `${origin}/account/payment-methods/`,
    ` ${origin}/account/payment-methods`,
    `${origin}/account\\payment-methods`,
    `${origin}/account/payment-methods?${"x".repeat(4096)}`,
  ])("J3 refuses raw MCP aliases and forbidden material before runtime/persistence/fetch: %s", async (raw) => {
    const runtime = services();
    const setup = vi.spyOn(runtime.payments, "createSavedCheckoutSetupSession");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handlers = createPaymentMcpHandlers(runtime.payments, runtime.evidenceWindowCorrelation);
    await expect(handlers.toolHandlers["payments.start-payment-method-setup"]!(mcpInput(raw))).rejects.toThrow(
      "evidence-window-provider-write:unsafe-material",
    );
    expect(setup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await journal.readWindow(windowId)).toEqual([]);
  });

  it("J3 refuses missing base and bad runtime paths before avoidable Customer work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const input of [{}, { returnUrlBase: origin, returnUrlPath: "/account/payment-methods?x=1" }]) {
      await expect(services().payments.createSavedCheckoutSetupSession({ accountId, ...input })).rejects.toThrow(
        "unsafe-material",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await journal.readWindow(windowId)).toEqual([]);
  });

  it("J3 a newly opened window cannot admit a URL normalized under a trusted null snapshot", async () => {
    let lookups = 0;
    correlation = {
      currentOpenWindow: async () => (++lookups === 1 ? null : { windowId, expiresAt: "2099-01-01T00:00:00Z" }),
    };
    const runtime = services();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handlers = createPaymentMcpHandlers(runtime.payments, runtime.evidenceWindowCorrelation);
    await expect(
      handlers.toolHandlers["payments.start-payment-method-setup"]!(
        mcpInput(
          `https://SYNTHETIC_REJECTED@marketplace.staging.chasesets.com/account/payment-methods#SYNTHETIC_REJECTED`,
        ),
      ),
    ).rejects.toThrow("evidence-window-provider-write:window-ineligible");
    expect(fetch).not.toHaveBeenCalled();
    expect(await journal.readWindow(windowId)).toEqual([]);
  });

  it.each(["account", "checkout"])(
    "J3 admits bound %s payment URLs through the deployed mapper and store",
    async (route) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const rows = await journal.readWindow(windowId);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.envelope!.bodyText).toBe(init.body);
          expect(new URLSearchParams(String(init.body)).get("return_url")).toBe(
            `${origin}/${route}/payments/${paymentId}`,
          );
          return Response.json({ id: "cs_SYNTHETIC_PAYMENT", status: "open" });
        }),
      );
      await gateway().createPaymentSession({
        paymentId,
        buyerAccountId: accountId,
        orderIds: [],
        amount: "1.00",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Synthetic payment",
        returnUrl: `${origin}/${route}/payments/${paymentId}`,
      });
    },
  );

  it("J3 refuses wrong operation IDs and unknown fields without persisting a digest", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      gateway().createPaymentSession({
        paymentId,
        buyerAccountId: accountId,
        orderIds: [],
        amount: "1.00",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Synthetic payment",
        returnUrl: `${origin}/account/payments/pay_OTHER`,
      }),
    ).rejects.toThrow("unsafe-material");
    const input = customerRequest();
    expect(
      await journal.reserveOrResolve({
        ...input,
        envelope: {
          ...input.envelope,
          bodyText: `${input.envelope.bodyText}&shared_payment_granted_token=SYNTHETIC_REJECTED`,
        },
      }),
    ).toEqual({ kind: "refused", code: "unsafe-material" });
    expect(await journal.readWindow(windowId)).toEqual([]);
  });

  it("J1/J2/J4 recovers a lost response once after restart and rejects late completion", async () => {
    const input = customerRequest();
    const original = requireProviderWrite(await journal.reserveOrResolve(input));
    const restarted = createPostgresEvidenceWindowProviderWrite(pools.payments);
    const same = requireProviderWrite(await restarted.reserveOrResolve(input));
    expect(same).toEqual(original);
    const replay = requireProviderWrite(await restarted.claimReplay(same.key, same.version, new Date().toISOString()));
    expect(replay.replayAttempts).toBe(1);
    expect(
      await journal.complete(original.key, original.version, { state: "succeeded", providerReference: "cus_LATE" }),
    ).toEqual({ kind: "stale-write-rejected" });
    expect(await restarted.claimReplay(replay.key, replay.version, new Date().toISOString())).toEqual({
      kind: "refused",
      code: "write-unresolved",
    });
    expect((await restarted.readWindow(windowId))[0]!.state).toBe("ambiguous");
  });

  it("J1/J4 deployed response-loss recovery sends stored bytes once more and completed repetition only retrieves", async () => {
    let posts = 0;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts++;
        const row = (await journal.readWindow(windowId))[0]!;
        expect(row.state).toBe("pending");
        expect(init.body).toBe(row.envelope!.bodyText);
        if (posts === 1) throw new Error("SYNTHETIC_PRIVATE_TRANSPORT_ERROR");
        expect(row.replayAttempts).toBe(1);
      }
      return Response.json({ id: "cus_SYNTHETIC_RECOVERY" });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(gateway().createCustomer({ accountId })).rejects.toThrow(
      "evidence-window-provider-write:write-unresolved",
    );
    expect((await journal.readWindow(windowId))[0]!.state).toBe("pending");
    journal = createPostgresEvidenceWindowProviderWrite(pools.payments);
    await gateway().createCustomer({ accountId });
    const completed = await journal.readWindow(windowId);
    for (let repeat = 0; repeat < 3; repeat++) await gateway().createCustomer({ accountId });
    expect(posts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(await journal.readWindow(windowId)).toEqual(completed);
    expect(JSON.stringify(completed)).not.toContain("SYNTHETIC_PRIVATE_TRANSPORT_ERROR");
  });

  it("J1/J3 both cancellations reserve only their POST and preserve absent versus empty bodies and terminal GET", async () => {
    let setupStatus = "requires_payment_method";
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const setup = url.includes("setup_intents");
      const id = setup ? "seti_SYNTHETIC_CANCEL" : "pi_SYNTHETIC_CANCEL";
      if (init.method === "GET") return Response.json({ id, status: setupStatus });
      if (url.endsWith("/cancel")) {
        const row = (await journal.readWindow(windowId)).find(
          (candidate) =>
            providerWriteIdempotencyKey(candidate.key) === new Headers(init.headers).get("Idempotency-Key"),
        )!;
        expect(row.state).toBe("pending");
        expect(row.key.operation).toBe("dispose");
        expect(row.envelope!.bodyKind).toBe(setup ? "form" : "absent");
        expect(init.body).toBe(setup ? "" : undefined);
        if (setup) setupStatus = "canceled";
        return Response.json({ id, status: "canceled" });
      }
      return Response.json({ id, status: "requires_payment_method" });
    });
    vi.stubGlobal("fetch", fetch);
    const adapter = gateway();
    await adapter.createSetupSession({
      accountId,
      setupReferenceId: "scs_SYNTHETIC_CANCEL",
      providerCustomerReference: "cus_SYNTHETIC",
      uiMode: "embedded",
      currencyCode: "usd",
      consentId: "consent_SYNTHETIC",
      consentText: "Synthetic consent",
    });
    await adapter.createPaymentSession({
      paymentId,
      buyerAccountId: accountId,
      orderIds: [],
      amount: "1.00",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Synthetic cancellation",
      savedCheckoutInstrument: {
        instrumentId: "sci_SYNTHETIC",
        providerReference: "pm_SYNTHETIC",
        confirmationExperience: "off-session-token",
      },
    });
    for (const original of await journal.readWindow(windowId)) {
      const rowKey = { ...original.key, operation: "dispose" as const };
      const governance = {
        kind: "governed" as const,
        rowKey,
        expectedVersion: 1,
        idempotencyKey: providerWriteIdempotencyKey(rowKey),
      };
      if (original.key.objectClass === 2) await adapter.cancelPayment(original.providerReference!, governance);
      else await adapter.cancelSetupSession(original.providerReference!, governance);
    }
    const before = await journal.readWindow(windowId);
    expect(before).toHaveLength(4);
    expect(before.every((row) => row.state === "succeeded")).toBe(true);
    const calls = fetch.mock.calls.filter(([, init]) => init.method === "POST").length;
    await expect(adapter.cancelSetupSession("seti_SYNTHETIC_CANCEL", { kind: "ungoverned" })).resolves.toMatchObject({
      outcome: "already-terminal",
    });
    expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(calls);
    expect(await journal.readWindow(windowId)).toEqual(before);
  });

  it("J2 records capture on the class-2 address without allocating a class-1 key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "pi_SYNTHETIC_CAPTURE", status: "succeeded" })),
    );
    await gateway().createPaymentSession({
      paymentId,
      buyerAccountId: accountId,
      orderIds: [],
      amount: "1.00",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Synthetic capture",
      savedCheckoutInstrument: {
        instrumentId: "sci_SYNTHETIC",
        providerReference: "pm_SYNTHETIC",
        confirmationExperience: "off-session-token",
      },
    });
    const rows = await journal.readWindow(windowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: { objectClass: 2, creationOrdinal: 1 }, observedClass: 1, version: 3 });
  });

  it("J1/J6 every completion predicate includes the full primary key and expected version", async () => {
    const row = requireProviderWrite(await journal.reserveOrResolve(customerRequest()));
    for (const key of [
      { ...row.key, windowId: "b".repeat(32) },
      { ...row.key, objectClass: 2 as const },
      { ...row.key, creationOrdinal: 2 },
      { ...row.key, operation: "dispose" as const },
    ]) {
      expect(await journal.complete(key, row.version, { state: "succeeded", providerReference: "cus_WRONG" })).toEqual({
        kind: "stale-write-rejected",
      });
    }
    expect(
      await journal.complete(row.key, row.version + 1, { state: "succeeded", providerReference: "cus_WRONG" }),
    ).toEqual({ kind: "stale-write-rejected" });
    expect(await journal.readWindow(windowId)).toEqual([row]);
  });

  it("J2 preserves logical identities, exact material and owner across three repeats; refuses ordinal 65", async () => {
    for (let index = 0; index < 64; index++)
      requireProviderWrite(await journal.reserveOrResolve(customerRequest(`acc_SYNTHETIC_${index}` as AccountId)));
    for (let repeat = 0; repeat < 3; repeat++)
      expect((await journal.reserveOrResolve(customerRequest("acc_SYNTHETIC_0" as AccountId))).kind).toBe("existing");
    expect(await journal.reserveOrResolve(customerRequest("acc_SYNTHETIC_64" as AccountId))).toEqual({
      kind: "refused",
      code: "ordinal-exhausted",
    });
    const input = customerRequest("acc_SYNTHETIC_0" as AccountId);
    expect(
      await journal.reserveOrResolve({
        ...input,
        envelope: {
          ...input.envelope,
          bodyText: new URLSearchParams({
            "metadata[account_id]": "acc_SYNTHETIC_0",
            name: "Synthetic Customer",
          }).toString(),
        },
      }),
    ).toEqual({ kind: "refused", code: "binding-drift" });
    expect(await journal.readWindow(windowId)).toHaveLength(64);
  });

  it("J2 records Customer reuse without any request material or provider call", async () => {
    const row = requireProviderWrite(
      await journal.observeCustomerReuse({
        windowId,
        ownerAccountId: accountId,
        providerReference: "cus_SYNTHETIC_REUSE",
        retentionSeconds: 3600,
      }),
    );
    expect(row).toMatchObject({
      state: "succeeded",
      reusedExisting: true,
      envelope: null,
      digest: null,
      providerReference: "cus_SYNTHETIC_REUSE",
    });
    for (let repeat = 0; repeat < 3; repeat++)
      expect(
        requireProviderWrite(
          await journal.observeCustomerReuse({
            windowId,
            ownerAccountId: accountId,
            providerReference: "cus_SYNTHETIC_REUSE",
            retentionSeconds: 3600,
          }),
        ),
      ).toEqual(row);
  });

  it.each([-1, 0, 1])("J4 enforces the immutable replay deadline at offset %i ms", async (offset) => {
    const row = requireProviderWrite(await journal.reserveOrResolve(customerRequest()));
    const result = await journal.claimReplay(
      row.key,
      row.version,
      new Date(Date.parse(row.replayDeadline) + offset).toISOString(),
    );
    expect(result.kind).toBe(offset < 0 ? "existing" : "refused");
    expect((await journal.readWindow(windowId))[0]!.replayDeadline).toBe(row.replayDeadline);
  });

  it("J2/J4 three Connect slots retain null references and saved response retrieval does not mutate rows", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("account_sessions")
        ? Response.json({ client_secret: "SYNTHETIC_ACCOUNT_SESSION", expires_at: Math.floor(Date.now() / 1000) + 600 })
        : Response.json({ id: "acct_SYNTHETIC_J", requirements: {}, capabilities: {} }),
    );
    vi.stubGlobal("fetch", fetch);
    const connect = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test_SYNTHETIC",
      webhookSecret: "whsec_SYNTHETIC",
      evidenceWindowCorrelation: correlation,
      evidenceWindowProviderWrite: journal,
      savedResponseUsability: async () => "qualified-unused",
    });
    const input = { accountId, providerReference: "acct_SYNTHETIC_J", idempotencyKey: "must-not-reach-session" };
    await connect.createPayoutSetupSession({ ...input, evidenceWindowSlot: 1 });
    await connect.createPayoutAccountManagementSession({ ...input, evidenceWindowSlot: 2 });
    await connect.createPayoutNotificationBannerSession({ ...input, evidenceWindowSlot: 3 });
    const before = await journal.readWindow(windowId);
    expect(before.map((row) => row.logicalSlot)).toEqual([1, 2, 3]);
    expect(before.every((row) => row.providerReference === null && row.state === "succeeded")).toBe(true);
    for (let repeat = 0; repeat < 3; repeat++)
      await connect.createPayoutNotificationBannerSession({ ...input, evidenceWindowSlot: 3 });
    expect(await journal.readWindow(windowId)).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("SYNTHETIC_ACCOUNT_SESSION");
    const row = before[2]!;
    for (const usability of ["consumed", "unqualified"] as const)
      expect(
        await journal.admitSavedResponse(row.key, { ...row.binding, usability }, new Date().toISOString()),
      ).toEqual({ kind: "refused", code: "response-unqualified" });
  });

  it("J2/J4 two Account Session tabs share one slot, one replay, and a stale original response cannot win", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (++posts === 1) {
          enter();
          await released;
        }
        return Response.json({
          client_secret: "SYNTHETIC_TWO_TAB_SECRET",
          expires_at: Math.floor(Date.now() / 1000) + 600,
        });
      }),
    );
    const connect = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test_SYNTHETIC",
      webhookSecret: "whsec_SYNTHETIC",
      evidenceWindowCorrelation: correlation,
      evidenceWindowProviderWrite: journal,
    });
    const input = {
      accountId,
      providerReference: "acct_SYNTHETIC",
      idempotencyKey: "SYNTHETIC_UNUSED",
      evidenceWindowSlot: 3 as const,
    };
    const first = connect.createPayoutNotificationBannerSession(input);
    const firstResult = first.then(
      () => "unexpected-success",
      (error: Error) => error.message,
    );
    await entered;
    await connect.createPayoutNotificationBannerSession(input);
    release();
    expect(await firstResult).toBe("evidence-window-provider-write:stale-write-rejected");
    const rows = await journal.readWindow(windowId);
    expect(posts).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ logicalSlot: 3, state: "succeeded", replayAttempts: 1, providerReference: null });
    await expect(connect.createPayoutNotificationBannerSession(input)).rejects.toThrow("response-unqualified");
    expect(posts).toBe(2);
  });

  it("J4 definitive provider refusal records failed while keeping the raw provider error private", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: "SYNTHETIC_PRIVATE_PROVIDER_ERROR" } }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(gateway().createCustomer({ accountId })).rejects.toThrow(
      "evidence-window-provider-write:write-unresolved",
    );
    const rows = await journal.readWindow(windowId);
    expect(rows[0]).toMatchObject({ state: "failed", providerReference: null });
    await expect(gateway().createCustomer({ accountId })).rejects.toThrow(
      "evidence-window-provider-write:write-failed",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_ERROR");
  });

  it("J1/J6 governed agentic material never reaches the journal or network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      gateway().createAgenticPaymentSession!({
        paymentId,
        buyerAccountId: accountId,
        orderIds: [],
        amount: "1.00",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Synthetic agentic refusal",
        agenticPayment: { kind: "stripe-shared-payment-token", sharedPaymentGrantedToken: "SYNTHETIC_FORBIDDEN_TOKEN" },
      }),
    ).rejects.toThrow("evidence-window-provider-write:unsafe-material");
    expect(fetch).not.toHaveBeenCalled();
    expect(await journal.readWindow(windowId)).toEqual([]);
  });

  it("J6 converges existing registration and fresh bootstrap to one private journal with bounded constraints", async () => {
    await pools.payments.query(platformControlPlaneSchemaSql);
    const columns = await pools.payments.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.columns WHERE table_name = 'evidence_window'",
    );
    expect(Number(columns.rows[0]!.count)).toBe(8);
    const row = requireProviderWrite(await journal.reserveOrResolve(customerRequest()));
    for (const assignment of [
      "version = 0",
      "creation_ordinal = 65",
      "replay_attempts = 2",
      "logical_slot = 1",
      "provider_reference = 'cus_PENDING'",
    ]) {
      await expect(
        pools.payments.query(`UPDATE evidence_window_provider_write SET ${assignment} WHERE window_id = $1`, [
          windowId,
        ]),
      ).rejects.toThrow();
    }
    expect((await journal.readWindow(windowId))[0]).toEqual(row);
  });
});
