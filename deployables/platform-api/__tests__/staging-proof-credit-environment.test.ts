import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadDeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import type { SettlementServices } from "@chase-sets/settlement/server";
import * as postgres from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("staging-proof-credit-environment config to composed route", () => {
  it("real console writes retain the pin through disabled/expired projection fallback and refuse replacement authority", async () => {
    const memory = createInMemoryEventStore();
    const store = vi.spyOn(postgres, "createPostgresEventStore").mockReturnValue({
      ...memory.eventStore,
      appendToStreamInTransaction: async () => {
        throw new Error("Synthetic console test does not use transaction-local appends.");
      },
      appendToStreamsInTransaction: async () => {
        throw new Error("Synthetic console test does not use transaction-local multi-stream appends.");
      },
      readStreamInTransaction: async () => {
        throw new Error("Synthetic console test does not use transaction-local reads.");
      },
    });
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/synthetic_unused",
      contextDatabaseUrls: {},
      port: 6182,
    });
    const query = vi.spyOn(pools.settlement, "query").mockResolvedValue({ rows: [], rowCount: 0 });
    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: { deploymentEnvironment: "staging", processorGateway: createFakePaymentProcessorGateway() },
      });
      const actor = {
        sessionId: "ses_synthetic",
        tenantId: "tnt_synthetic",
        userId: "usr_synthetic",
        accountId: "acc_synthetic",
        membershipId: "mem_synthetic",
        roleKey: "platform-admin",
        permissions: ["platform-policy.manage", "wallet-adjustments.create", "wallet-adjustments.approve"],
        authenticatedAt: new Date().toISOString(),
      };
      const app = buildPlatformApiApp(runtime, { resolveActor: async () => actor });
      const revise = (value: unknown, effectiveUntil: string | null = null) =>
        app.request("/api/platform/policy-console/settlement.staging-proof-credit/revisions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value, status: "active", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil }),
        });
      expect((await revise({ enabled: true, proofAccountId: actor.accountId })).status).toBe(201);
      const post = () =>
        app.request("/api/settlement/wallet/staging-proof-credits", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Chase-Sets-CSRF": "1" },
          body: JSON.stringify({ targetAccountId: actor.accountId, amount: "25.00" }),
        });
      expect((await post()).status).toBe(200);
      expect((await revise({ enabled: false, proofAccountId: actor.accountId })).status).toBe(201);
      expect((await post()).status).toBe(409);
      expect((await revise({ enabled: false, proofAccountId: null })).status).toBe(400);
      expect((await revise({ enabled: true, proofAccountId: "acc_replacement" })).status).toBe(400);
      expect(
        (await revise({ enabled: true, proofAccountId: actor.accountId }, "2026-02-01T00:00:00.000Z")).status,
      ).toBe(201);
      expect((await post()).status).toBe(409);
      expect((await revise({ enabled: true, proofAccountId: actor.accountId })).status).toBe(201);
      expect((await post()).status).toBe(200);
      expect(
        memory.allEvents.filter((event) => event.eventType === "settlement.wallet.staging-proof-credit-posted"),
      ).toHaveLength(1);
      expect(
        new Set(
          memory.allEvents
            .filter((event) => event.eventType.startsWith("platform-policy."))
            .map((event) => event.streamId),
        ).size,
      ).toBe(1);
    } finally {
      store.mockRestore();
      query.mockRestore();
      await closePlatformApiPools(pools);
    }
  });
  it("threads the imported host config, not a hostname or request value", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("deploymentEnvironment: config.deploymentEnvironment");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "staging", nodeEnv: "production" })).toBe("staging");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "", nodeEnv: "production" })).toBe("production");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "", nodeEnv: "test" })).toBe("test");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "", nodeEnv: "development" })).toBe("dev");
    expect(() => loadDeploymentEnvironment({ deploymentEnvironment: "unrecognized" })).toThrow();
  });

  it.each(["production", "preview", "test", "dev", "remote-dev", "local", undefined, "unrecognized", "staging"])(
    "staging-proof-credit-production-isolation: real host binding %s",
    async (deploymentEnvironment) => {
      const pools = createPlatformApiPools({
        runtimeProfile: "public",
        sharedDatabaseUrl: "postgresql://localhost/synthetic_unused",
        contextDatabaseUrls: {},
        port: 6182,
      });
      try {
        const runtime = createPlatformApiHost({
          runtimeProfile: "public",
          pools,
          hostPorts: { deploymentEnvironment, processorGateway: createFakePaymentProcessorGateway() },
        });
        const settlement = runtime.services.settlement as SettlementServices;
        expect(settlement.stagingProofCredits.deploymentEnvironment).toBe(deploymentEnvironment);
        const post = vi.spyOn(settlement.stagingProofCredits, "post");
        const actor = {
          sessionId: "ses_synthetic",
          tenantId: "tnt_synthetic",
          userId: "usr_synthetic",
          accountId: "acc_synthetic",
          membershipId: "mem_synthetic",
          roleKey: "platform-admin",
          permissions: ["wallet-adjustments.create", "wallet-adjustments.approve"],
          authenticatedAt: new Date().toISOString(),
        };
        if (deploymentEnvironment === "staging") post.mockResolvedValue({ proof: "7806-ac6" } as never);
        const app = buildPlatformApiApp(runtime, { resolveActor: async () => actor });
        const response = await app.request("/api/settlement/wallet/staging-proof-credits", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Chase-Sets-CSRF": "1",
            Host: "staging.example.test",
            "X-Deployment-Environment": "staging",
          },
          body: JSON.stringify({ targetAccountId: actor.accountId, amount: "25.00" }),
        });
        expect(response.status).toBe(deploymentEnvironment === "staging" ? 200 : 409);
        if (deploymentEnvironment !== "staging") {
          expect(post).not.toHaveBeenCalled();
          await expect(
            settlement.stagingProofCredits.post({ targetAccountId: "acc_synthetic", amount: "25.00" }, actor, {
              tenantId: "tnt_synthetic",
              audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
            }),
          ).rejects.toThrow("proof_environment_refused");
        }
      } finally {
        await closePlatformApiPools(pools);
      }
    },
  );
});
