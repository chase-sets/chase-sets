import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";
import type { SettlementServices } from "../../../support/runtime-support/services";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import type { WalletServices } from "../../wallets/api/runtime";
import { createSettlementPayoutMcpHandlers } from "./mcp";
import { createPayoutProviderEvents } from "./payout-provider-events";
import { createPayoutReconciliation } from "./payout-reconciliation";
import { createPayoutReconciliationJobs } from "./payout-reconciliation-jobs";
import { createPayoutRequestLifecycle } from "./payout-request-lifecycle";
import { createMoneyMovementWebhookRoutes, createPayoutRoutes } from "./route";
import { createPayoutRuntime, type PayoutServices } from "./runtime";

vi.mock("./payout-request-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payout-request-lifecycle")>();
  return { ...actual, createPayoutRequestLifecycle: vi.fn(actual.createPayoutRequestLifecycle) };
});
vi.mock("./payout-provider-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payout-provider-events")>();
  return { ...actual, createPayoutProviderEvents: vi.fn(actual.createPayoutProviderEvents) };
});
vi.mock("./payout-reconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payout-reconciliation")>();
  return { ...actual, createPayoutReconciliation: vi.fn(actual.createPayoutReconciliation) };
});
vi.mock("./payout-reconciliation-jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payout-reconciliation-jobs")>();
  return { ...actual, createPayoutReconciliationJobs: vi.fn(actual.createPayoutReconciliationJobs) };
});

const payoutServiceOwnership = {
  composition: ["commandHandler", "projectors"],
  requestLifecycle: [
    "listPayouts",
    "getPayoutSummary",
    "getPayout",
    "getPayoutQuickAmounts",
    "getPayoutMoneyTimeline",
    "previewPayoutRequest",
    "requestPayout",
    "markPayoutInTransit",
    "completePayout",
    "failPayout",
  ],
  providerEvents: ["processMoneyMovementWebhook", "getProviderHealth"],
  reconciliation: [
    "reconcileProviderPayout",
    "reconcilePayoutsNeedingAttention",
    "listPayoutsNeedingReconciliation",
    "listProviderIdempotencyKeys",
    "listReconciliationRuns",
    "listNegativeBalanceAccounts",
    "getPlatformBalanceForecast",
  ],
  reconciliationJobs: [
    "enqueuePayoutReconciliationJob",
    "getPayoutReconciliationJob",
    "listPayoutReconciliationJobEvents",
    "waitForPayoutReconciliationJobEvents",
    "prunePayoutReconciliationJobRetention",
    "processNextPayoutReconciliationJob",
    "getPayoutReconciliationWorkUnitSummary",
  ],
} as const satisfies Readonly<Record<string, readonly (keyof PayoutServices)[]>>;

type OwnedMember<Family extends keyof typeof payoutServiceOwnership> = (typeof payoutServiceOwnership)[Family][number];

const runtimeModules = [
  "runtime.ts",
  "payout-primitives.ts",
  "payout-request-lifecycle.ts",
  "payout-provider-events.ts",
  "payout-reconciliation.ts",
  "payout-reconciliation-jobs.ts",
] as const;

function readRuntimeModule(file: (typeof runtimeModules)[number]) {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

function createRuntime() {
  return createPayoutRuntime({
    eventStore: createInMemoryEventStore().eventStore,
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
    db: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    wallets: {} as WalletServices,
    payoutReadiness: {} as PayoutReadinessServices,
    moneyMovementGateway: createFakeMoneyMovementGateway(),
  });
}

describe("payout runtime composition", () => {
  it("payout service member ownership is complete", () => {
    expectTypeOf<OwnedMember<keyof typeof payoutServiceOwnership>>().toEqualTypeOf<keyof PayoutServices>();

    const services = createRuntime();
    const families = {
      requestLifecycle: vi.mocked(createPayoutRequestLifecycle).mock.results.at(-1)?.value,
      providerEvents: vi.mocked(createPayoutProviderEvents).mock.results.at(-1)?.value,
      reconciliation: vi.mocked(createPayoutReconciliation).mock.results.at(-1)?.value,
      reconciliationJobs: vi.mocked(createPayoutReconciliationJobs).mock.results.at(-1)?.value,
    };
    const owned = Object.values(payoutServiceOwnership).flat();

    expect(new Set(owned).size).toBe(owned.length);
    expect(Object.keys(services).sort()).toEqual([...owned].sort());
    for (const [family, members] of Object.entries(families)) {
      const expected = payoutServiceOwnership[family as keyof typeof families];
      expect(Object.keys(members ?? {}).sort(), family).toEqual([...expected].sort());
      for (const member of expected) {
        expect(services[member], `${family}.${member}`).toBe((members as Record<string, unknown>)[member]);
      }
    }
  });

  it("keeps runtime.ts as the composition entry with one construction of each shared store", () => {
    const runtime = readRuntimeModule("runtime.ts");
    const declaredFunctions = [...runtime.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(
      (match) => match[1],
    );

    expect(declaredFunctions).toEqual(["toPayoutReconciliationJobStatus", "createPayoutRuntime"]);
    expect(runtime).not.toMatch(/\basync\b|\bawait\b/);

    const constructions = (pattern: RegExp) =>
      runtimeModules.flatMap((file) => [...readRuntimeModule(file).matchAll(pattern)].map(() => file));
    expect(constructions(/\bcreateAggregateCommandHandler\(/g)).toEqual(["runtime.ts", "runtime.ts"]);
    expect(constructions(/\bcreatePostgresDurableJobStore</g)).toEqual(["payout-reconciliation-jobs.ts"]);
    expect(constructions(/\bcreatePostgresDurableJobWorkUnitStore</g)).toEqual(["payout-reconciliation-jobs.ts"]);
    expect(constructions(/\bcreateNoopNotificationOutbox\(\)/g)).toEqual(["runtime.ts"]);
    expect(constructions(/\bcreateNoopSettlementOperationsRecorder\(\)/g)).toEqual(["runtime.ts"]);
  });

  it("real PayoutServices consumers compile", () => {
    const services = createRuntime();

    expectTypeOf(services).toEqualTypeOf<PayoutServices>();
    expectTypeOf<SettlementServices["payouts"]>().toEqualTypeOf<PayoutServices>();
    expectTypeOf(createPayoutRoutes).parameter(0).toEqualTypeOf<PayoutServices>();
    expectTypeOf(createMoneyMovementWebhookRoutes).parameter(0).toEqualTypeOf<PayoutServices>();
    expectTypeOf(createSettlementPayoutMcpHandlers).parameter(0).toEqualTypeOf<PayoutServices>();
    expectTypeOf(createPayoutRequestLifecycle).returns.toEqualTypeOf<
      Pick<PayoutServices, OwnedMember<"requestLifecycle">>
    >();
    expectTypeOf(createPayoutProviderEvents).returns.toEqualTypeOf<
      Pick<PayoutServices, OwnedMember<"providerEvents">>
    >();
    // The reconciliation slice keeps the signal-aware provider payout read its durable jobs call.
    expectTypeOf(createPayoutReconciliation).returns.toExtend<Pick<PayoutServices, OwnedMember<"reconciliation">>>();
    expectTypeOf(createPayoutReconciliationJobs).returns.toEqualTypeOf<
      Pick<PayoutServices, OwnedMember<"reconciliationJobs">>
    >();

    expect(createPayoutRoutes(services).routes.length).toBeGreaterThan(0);
    expect(createMoneyMovementWebhookRoutes(services).routes.length).toBeGreaterThan(0);
    expect(Object.keys(createSettlementPayoutMcpHandlers(services)).length).toBeGreaterThan(0);
  });
});
