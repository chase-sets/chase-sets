import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWalletRoutes, type WalletServices } from "@chase-sets/settlement/server";
import { buildPlatformApiApp } from "../src/app";

/**
 * The exact account-scoped payout authority an owner or manager holds. The
 * arbitrary-account self-credit exploit is closed when a caller carrying this
 * authority is still rejected on the operator wallet-mutation routes through
 * the composed platform API runtime -- not merely a unit-constructed app.
 */
const PAYOUT_OPERATOR_PERMISSIONS = [
  "payouts.manage",
  "payouts.reconcile",
  "payouts.request",
  "payouts.setup",
  "payouts.view",
] as const;

const OPERATOR_WALLET_MUTATION_PATHS = [
  "/api/settlement/wallet/refund-debits",
  "/api/settlement/wallet/dispute-holds",
  "/api/settlement/wallet/dispute-releases",
] as const;

function walletActor(permissions: readonly string[]) {
  return {
    sessionId: "sess_operator",
    tenantId: "tenant_1",
    userId: "user_operator",
    accountId: "acc_operator",
    membershipId: "member_1",
    roleKey: "owner",
    permissions,
  };
}

function createSettlementWalletRuntime(postEntry: WalletServices["postEntry"]) {
  const walletRouter = new Hono();
  walletRouter.route("/", createWalletRoutes({ postEntry } as unknown as WalletServices));
  const module = {
    contextName: "settlement",
    apiMounts: [{ mountPath: "/api/settlement", kind: "primary", requiresAuth: true }],
    buildApis: () => [{ mountPath: "/api/settlement", contextMountOrdinal: 1, router: walletRouter }],
    projectionHandlerSets: () => [],
  };

  return {
    mountedContexts: [
      {
        contextName: "settlement",
        mountRole: "active",
        module,
        services: {},
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module, services: {} }],
    services: {
      auth: {},
      identity: {},
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
}

describe("platform api operator wallet-mutation authorization", () => {
  it("rejects account-scoped payout operators on every operator wallet-mutation route", async () => {
    const postEntry = vi.fn();
    const app = buildPlatformApiApp(createSettlementWalletRuntime(postEntry as never), {
      resolveActor: vi.fn(async () => walletActor([...PAYOUT_OPERATOR_PERMISSIONS])),
    });

    for (const path of OPERATOR_WALLET_MUTATION_PATHS) {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc_operator",
          amount: "1000.00",
          idempotencyKey: `exploit:${path}`,
          auditReason: "attempted self-mutation",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authorization_forbidden" },
      });
    }
    expect(postEntry).not.toHaveBeenCalled();
  });

  it("keeps unauthenticated operator wallet-mutation requests at 401 through the composed runtime", async () => {
    const postEntry = vi.fn();
    const app = buildPlatformApiApp(createSettlementWalletRuntime(postEntry as never), {
      resolveActor: vi.fn(async () => null),
    });

    for (const path of OPERATOR_WALLET_MUTATION_PATHS) {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify({ accountId: "acc_operator", amount: "1.00" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(401);
    }
    expect(postEntry).not.toHaveBeenCalled();
  });

  it("admits a caller holding the dedicated wallet-adjustment authority", async () => {
    const postEntry = vi.fn(async () => ({ accountId: "acc_seller" as never, version: 2 }));
    const app = buildPlatformApiApp(createSettlementWalletRuntime(postEntry as never), {
      resolveActor: vi.fn(async () => walletActor(["wallet-adjustments.operate"])),
    });

    const response = await app.request("/api/settlement/wallet/dispute-releases", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc_seller",
        amount: "8.00",
        idempotencyKey: "authorized:acc_seller",
        auditReason: "authorized operator credit",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(postEntry).toHaveBeenCalledTimes(1);
  });
});
