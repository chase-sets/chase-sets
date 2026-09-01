import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWalletRoutes, type WalletServices } from "@chase-sets/settlement/server";
import { buildPlatformApiApp } from "../src/app";

const OPERATOR_WALLET_MUTATION_PATHS = [
  "/api/settlement/wallet/refund-debits",
  "/api/settlement/wallet/dispute-holds",
  "/api/settlement/wallet/dispute-releases",
] as const;

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

describe("platform api wallet routes", () => {
  it("legacy wallet operator mutation routes are removed", async () => {
    const postEntry = vi.fn();
    const app = buildPlatformApiApp(createSettlementWalletRuntime(postEntry as never));

    for (const path of OPERATOR_WALLET_MUTATION_PATHS) {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc_operator",
          amount: "1000.00",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("404 Not Found");
    }
    expect(postEntry).not.toHaveBeenCalled();
  });
});
