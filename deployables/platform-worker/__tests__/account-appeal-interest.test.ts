import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import {
  buildProjectionInterestIndex,
  lookupProjectionInterests,
} from "@chase-sets/platform-runtime/projection-interest-index";
import { listProjectionInterestOverridesForPushMigration } from "@chase-sets/platform-runtime/projection-push-migration";
import { createWorkerHost, type WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it } from "vitest";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const PROJECTION = "account-appeal-interest-projection";
const APPEAL_PROJECTION = "account-appeal-projection";
const APPEAL_EVENTS = [
  "platform-operations.account-appeal.filed",
  "platform-operations.account-appeal.review-started",
  "platform-operations.account-appeal.outcome-recorded",
  "platform-operations.account-appeal.withdrawn",
] as const;
const SOURCES = [
  ["identity", ["identity.account.suspended", "identity.account.reactivated", "identity.account.closed"]],
  ["marketplace", ["marketplace.listing.operator-unlisted", "marketplace.listing.auto-unlisted"]],
] as const;

describe("account appeal registry worker interest", () => {
  it("wakes and runs the registry checkpoint for every appealable source event", () => {
    const runtime = createPlatformWorkerHost();
    const index = interestIndex(runtime);
    const withoutRegistry = interestIndex(runtime, true);

    for (const [sourceContextName, eventTypes] of SOURCES) {
      const runners = runtime.subscriptionRunners.filter(
        (runner) => runner.sourceContextName === sourceContextName && runner.projectionName === PROJECTION,
      );
      expect(runners, sourceContextName).toHaveLength(1);
      expect(runners[0]).toMatchObject({
        targetContextName: "platform-operations",
        checkpointKey: `${PROJECTION}:${sourceContextName}:v1`,
        streamPrefixes: undefined,
      });
      expect([...(runners[0]?.eventTypes ?? [])].sort()).toEqual([...eventTypes].sort());
      expect(Object.keys(runners[0]?.handlers ?? {}).sort()).toEqual([...eventTypes].sort());

      for (const eventType of eventTypes) {
        const keys = (entries: ReturnType<typeof lookupProjectionInterests>) =>
          entries.map((entry) => `${entry.targetContextName}:${entry.projectionName}`);
        const woken = keys(lookupProjectionInterests(index, { sourceContextName, eventType }));
        expect(woken, eventType).toContain(`platform-operations:${PROJECTION}`);
        // Disabling the registry removes exactly its own interest and no sibling consumer's.
        expect(keys(lookupProjectionInterests(withoutRegistry, { sourceContextName, eventType })).sort()).toEqual(
          woken.filter((key) => key !== `platform-operations:${PROJECTION}`).sort(),
        );
      }
    }
  });
});

describe("account appeal lifecycle worker interest", () => {
  it("wakes the same-context replay projection for every private lifecycle event", () => {
    const runtime = createPlatformWorkerHost();
    const index = interestIndex(runtime);
    const runner = runtime.subscriptionRunners.find(
      (entry) => entry.sourceContextName === "platform-operations" && entry.projectionName === APPEAL_PROJECTION,
    );
    expect(runner).toMatchObject({
      targetContextName: "platform-operations",
      checkpointKey: `${APPEAL_PROJECTION}:platform-operations:v1`,
      streamPrefixes: undefined,
    });
    expect([...(runner?.eventTypes ?? [])].sort()).toEqual([...APPEAL_EVENTS].sort());
    for (const eventType of APPEAL_EVENTS) {
      expect(runner?.handlers?.[eventType]).toBeTypeOf("function");
      expect(
        lookupProjectionInterests(index, { sourceContextName: "platform-operations", eventType }).map(
          (entry) => `${entry.targetContextName}:${entry.projectionName}`,
        ),
      ).toContain(`platform-operations:${APPEAL_PROJECTION}`);
    }
  });
});

function interestIndex(runtime: WorkerHostRuntime, disableRegistry = false) {
  return buildProjectionInterestIndex({
    projectionGroups: runtime.projectionGroups,
    projectionOverrides: [
      ...(disableRegistry
        ? [
            {
              targetContextName: "platform-operations",
              projectionName: PROJECTION,
              disabled: true,
              optOutReason: "Disabled by WORKER_WAKE_DISABLED_PROJECTIONS.",
            },
          ]
        : []),
      ...listProjectionInterestOverridesForPushMigration(),
    ],
  });
}

function createPlatformWorkerHost() {
  const syntheticPricingHostPorts = {
    commercialTermsResolver: createNoopCommercialTermsResolver(),
    channelConnectionIdentityReader: { resolve: async () => null },
  } satisfies PricingHostPorts;
  return createWorkerHost(workerContextRegistry, "platform-worker", {
    pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts: {
      capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
      inventoryCleanupAuthority: { kind: "not-mounted" },
      channelSaleRecorder: createPlatformChannelSaleRecorder(createUnusedPool()),
      notificationAdapter: { send: async () => undefined },
      agentWebhookOrderResolvers: {
        resolveOrderRecipient: async () => null,
        resolveShipmentOrderId: async () => null,
        resolveWebhookTargets: async () => [],
      },
      ...syntheticPricingHostPorts,
    },
    runtimeProfile: "public",
  });
}

function createUnusedPool() {
  const fail = () => {
    throw new Error("The account appeal worker interest test must not touch database pools.");
  };
  return { query: fail, connect: fail } as never;
}
