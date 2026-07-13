import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createWalletAdjustmentRoutes } from "./wallet-adjustment-route";
import { StaleWalletBalanceError, type WalletAdjustmentServices } from "./wallet-adjustment-runtime";
import type { WalletServices } from "./runtime";

const OPERATOR_PERMISSIONS = [
  "wallet-adjustments.view",
  "wallet-adjustments.create",
  "wallet-adjustments.approve",
  "wallet-adjustments.reverse",
];

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    adjustment_id: "wad_1",
    status: "requested",
    target_account_id: "acc_target",
    direction: "credit",
    amount: "10.00",
    currency_code: "usd",
    reason_code: "goodwill-cash-credit",
    requested_by: "usr_operator",
    ...overrides,
  };
}

const DEFAULT_CONTROLS = {
  highValueCreditThresholdAmount: "500.00",
  highValueDebitThresholdAmount: "500.00",
  recentAuthMaxAgeMinutes: 15,
};

function createServices(overrides: Partial<WalletAdjustmentServices> = {}): WalletAdjustmentServices {
  return {
    deriveAdjustmentId: vi.fn(),
    resolveControls: vi.fn(async () => DEFAULT_CONTROLS as never),
    preview: vi.fn(async () => ({ balance_revision: "wbr_abc", direction: "credit", amount: "10.00" }) as never),
    getAccountSummary: vi.fn(
      async () => ({ account_id: "acc_target", updated_at: "2026-07-13T00:00:00.000Z" }) as never,
    ),
    request: vi.fn(async () => snapshot() as never),
    approve: vi.fn(async () => snapshot({ status: "approved" }) as never),
    reject: vi.fn(async () => snapshot({ status: "rejected" }) as never),
    post: vi.fn(async () => snapshot({ status: "posted" }) as never),
    approveAndPost: vi.fn(async () => snapshot({ status: "posted" }) as never),
    reverse: vi.fn(
      async () =>
        ({ original: snapshot({ status: "reversed" }), reversal: snapshot({ adjustment_id: "wad_2" }) }) as never,
    ),
    getAdjustment: vi.fn(async () => snapshot({ status: "posted" }) as never),
    listAdjustments: vi.fn(async () => ({ items: [snapshot()], total: 1 }) as never),
    listIncompleteAdjustments: vi.fn(async () => [] as never),
    ...overrides,
  };
}

const walletsStub: Pick<WalletServices, "listWalletEntries"> = {
  listWalletEntries: vi.fn(async () => ({ items: [], total: 0 })),
};

function createApp(
  services: WalletAdjustmentServices,
  permissions: readonly string[] | null,
  options: Readonly<{ authenticatedAt?: string | null }> = {},
) {
  // Recently authenticated by default so every pre-existing authorization/
  // validation test below is exercising only what it names, not incidentally
  // tripping the recent-auth ("step-up") gate too -- see the dedicated
  // "recent authentication (step-up)" describe block for that gate's tests.
  const authenticatedAt = "authenticatedAt" in options ? options.authenticatedAt : new Date().toISOString();
  const app = new Hono<SettlementApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_test",
            tenantId: "tnt_test",
            userId: "usr_operator",
            accountId: "acc_operator",
            membershipId: "mem_test",
            roleKey: "platform-admin",
            permissions,
            authenticatedAt,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createWalletAdjustmentRoutes(services, walletsStub));
  return app;
}

async function post(app: Hono<SettlementApiEnv>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("wallet adjustment routes: authorization", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const response = await createApp(createServices(), null).request("/wallet-adjustments");
    expect(response.status).toBe(401);
  });

  it("forbids an ordinary account operator holding only payout permissions", async () => {
    const app = createApp(createServices(), ["payouts.view", "payouts.manage"]);
    expect((await app.request("/wallet-adjustments")).status).toBe(403);
    expect((await post(app, "/wallet-adjustments/preview", { targetAccountId: "acc_target" })).status).toBe(403);
    expect(
      (
        await post(app, "/wallet-adjustments", {
          targetAccountId: "acc_target",
          direction: "credit",
          amount: "1.00",
          reasonCode: "goodwill-cash-credit",
        })
      ).status,
    ).toBe(403);
  });
});

describe("wallet adjustment routes: preview", () => {
  it("previews a proposed adjustment for an authorized operator", async () => {
    const services = createServices();
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/preview", {
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "10.00",
      reasonCode: "goodwill-cash-credit",
    });
    expect(response.status).toBe(200);
    expect(services.preview).toHaveBeenCalledWith(
      expect.objectContaining({ targetAccountId: "acc_target", direction: "credit", amount: "10.00" }),
    );
  });

  it("rejects an unsupported currency with a coded 400", async () => {
    const response = await post(createApp(createServices(), OPERATOR_PERMISSIONS), "/wallet-adjustments/preview", {
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "10.00",
      currencyCode: "eur",
      reasonCode: "goodwill-cash-credit",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details?: { code: string }[] } };
    expect(body.error.details?.[0]?.code).toBe("unsupported_currency");
  });

  it("rejects an unknown reason code", async () => {
    const response = await post(createApp(createServices(), OPERATOR_PERMISSIONS), "/wallet-adjustments/preview", {
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "10.00",
      reasonCode: "made-up-reason",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details?: { code: string }[] } };
    expect(body.error.details?.[0]?.code).toBe("invalid_reason_code");
  });

  it("rejects a malformed account identifier", async () => {
    const response = await post(createApp(createServices(), OPERATOR_PERMISSIONS), "/wallet-adjustments/preview", {
      targetAccountId: "not-an-account",
      direction: "credit",
      amount: "10.00",
      reasonCode: "goodwill-cash-credit",
    });
    expect(response.status).toBe(400);
  });
});

describe("wallet adjustment routes: request", () => {
  const validBody = {
    targetAccountId: "acc_target",
    direction: "credit",
    amount: "10.00",
    reasonCode: "goodwill-cash-credit",
  };

  it("requests an adjustment and returns the command-owned snapshot", async () => {
    const services = createServices();
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments", validBody);
    expect(response.status).toBe(201);
    expect(services.request).toHaveBeenCalledTimes(1);
  });

  it("derives a stable server-side idempotency key so retries reuse the adjustment", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS);
    await post(app, "/wallet-adjustments", validBody);
    await post(app, "/wallet-adjustments", validBody);
    const calls = (services.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect(calls[0][0].requestedBy).toBe("usr_operator");
  });

  it("scopes the idempotency key by a standards-based Idempotency-Key header", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS);
    await post(app, "/wallet-adjustments", validBody, { "Idempotency-Key": "op-123" });
    await post(app, "/wallet-adjustments", validBody);
    const calls = (services.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].idempotencyKey).not.toBe(calls[1][0].idempotencyKey);
  });

  it("returns 409 when the previewed balance is stale rather than posting against unseen state", async () => {
    const services = createServices({
      request: vi.fn(async () => {
        throw new StaleWalletBalanceError("wbr_old", "wbr_new");
      }),
    });
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments", {
      ...validBody,
      expectedBalanceRevision: "wbr_old",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details?: { code: string }[] } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.[0]?.code).toBe("stale_balance_revision");
  });

  it("rejects an amount over the permitted bound", async () => {
    const response = await post(createApp(createServices(), OPERATOR_PERMISSIONS), "/wallet-adjustments", {
      ...validBody,
      amount: "9999999.00",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details?: { code: string }[] } };
    expect(body.error.details?.[0]?.code).toBe("amount_out_of_bounds");
  });

  it("rejects too many evidence references", async () => {
    const response = await post(createApp(createServices(), OPERATOR_PERMISSIONS), "/wallet-adjustments", {
      ...validBody,
      evidenceReferences: Array.from({ length: 25 }, (_, index) => `ref-${index}`),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details?: { code: string }[] } };
    expect(body.error.details?.[0]?.code).toBe("too_many_evidence_references");
  });
});

describe("wallet adjustment routes: approve, reject, reverse", () => {
  it("approves and posts an existing adjustment", async () => {
    const services = createServices();
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/wad_1/approve", {});
    expect(response.status).toBe(200);
    expect(services.approveAndPost).toHaveBeenCalledWith(
      expect.objectContaining({ adjustmentId: "wad_1", approvedBy: "usr_operator" }),
      expect.anything(),
    );
  });

  it("returns 404 approving a non-existent adjustment", async () => {
    const services = createServices({ getAdjustment: vi.fn(async () => null) });
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/wad_1/approve", {});
    expect(response.status).toBe(404);
  });

  it("maps a separation-of-duties violation to 409", async () => {
    const services = createServices({
      approveAndPost: vi.fn(async () => {
        throw new (await import("../../../support/runtime-support/common")).SettlementDomainError(
          "A Wallet Adjustment cannot be approved by its requester.",
        );
      }),
    });
    const response = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/wad_1/approve", {});
    expect(response.status).toBe(409);
  });

  it("requires distinct approver identities to reverse a posted adjustment", async () => {
    const services = createServices();
    const missing = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/wad_1/reverse", {});
    expect(missing.status).toBe(400);

    const ok = await post(createApp(services, OPERATOR_PERMISSIONS), "/wallet-adjustments/wad_1/reverse", {
      approvedByUserId: "usr_approver",
      elevationApprovedByUserId: "usr_elevated",
    });
    expect(ok.status).toBe(201);
    expect(services.reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        adjustmentId: "wad_1",
        requestedBy: "usr_operator",
        approvedBy: "usr_approver",
        elevationApprovedBy: "usr_elevated",
      }),
      expect.anything(),
    );
  });
});

describe("wallet adjustment routes: recent authentication (step-up)", () => {
  const requestBody = {
    targetAccountId: "acc_target",
    direction: "credit",
    amount: "10.00",
    reasonCode: "goodwill-cash-credit",
  };

  it("rejects posting a request with a specific step-up-required response when the actor has no authentication moment", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: null });
    const response = await post(app, "/wallet-adjustments", requestBody);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("step_up_required");
    expect(services.request).not.toHaveBeenCalled();
  });

  it("rejects posting a request when the actor authenticated outside the policy's recent-auth window", async () => {
    const services = createServices();
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: stale });
    const response = await post(app, "/wallet-adjustments", requestBody);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("step_up_required");
    expect(services.request).not.toHaveBeenCalled();
  });

  it("allows posting a request when the actor authenticated within the policy's recent-auth window", async () => {
    const services = createServices();
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: fresh });
    const response = await post(app, "/wallet-adjustments", requestBody);
    expect(response.status).toBe(201);
    expect(services.request).toHaveBeenCalledTimes(1);
  });

  it("rejects approval with step-up-required when the session is not recently authenticated", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: null });
    const response = await post(app, "/wallet-adjustments/wad_1/approve", {});
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("step_up_required");
    expect(services.approveAndPost).not.toHaveBeenCalled();
  });

  it("rejects reversal with step-up-required when the session is not recently authenticated", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: null });
    const response = await post(app, "/wallet-adjustments/wad_1/reverse", {
      approvedByUserId: "usr_approver",
      elevationApprovedByUserId: "usr_elevated",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("step_up_required");
    expect(services.reverse).not.toHaveBeenCalled();
  });

  it("does not require recent authentication to preview, reject, or read", async () => {
    const services = createServices();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt: null });

    expect((await post(app, "/wallet-adjustments/preview", requestBody)).status).toBe(200);
    expect((await post(app, "/wallet-adjustments/wad_1/reject", {})).status).toBe(200);
    expect((await app.request("/wallet-adjustments")).status).toBe(200);
  });

  it("resolves the recent-auth window from the live policy, not a hardcoded value", async () => {
    const services = createServices({
      resolveControls: vi.fn(async () => ({
        highValueCreditThresholdAmount: "500.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 60,
      })) as never,
    });
    // 30 minutes old: stale under the ADR compiled default (15 min) but
    // fresh under this policy's revised 60-minute window.
    const authenticatedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const app = createApp(services, OPERATOR_PERMISSIONS, { authenticatedAt });
    const response = await post(app, "/wallet-adjustments", requestBody);
    expect(response.status).toBe(201);
    expect(services.request).toHaveBeenCalledTimes(1);
  });
});

describe("wallet adjustment routes: admin queries", () => {
  it("lists adjustments with a bounded limit", async () => {
    const services = createServices();
    const response = await createApp(services, OPERATOR_PERMISSIONS).request("/wallet-adjustments?limit=999");
    expect(response.status).toBe(200);
    expect((services.listAdjustments as ReturnType<typeof vi.fn>).mock.calls[0][0].limit).toBe(100);
  });

  it("rejects an invalid status filter", async () => {
    const response = await createApp(createServices(), OPERATOR_PERMISSIONS).request(
      "/wallet-adjustments?status=bogus",
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for an account with no wallet", async () => {
    const services = createServices({
      getAccountSummary: vi.fn(async () => ({ account_id: "acc_target", opened_at: null, updated_at: null }) as never),
    });
    const response = await createApp(services, OPERATOR_PERMISSIONS).request(
      "/wallet-adjustments/accounts/acc_target/summary",
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 fetching an unknown adjustment", async () => {
    const services = createServices({ getAdjustment: vi.fn(async () => null) });
    const response = await createApp(services, OPERATOR_PERMISSIONS).request("/wallet-adjustments/wad_missing");
    expect(response.status).toBe(404);
  });
});
