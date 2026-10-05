import { describe, expect, it, vi } from "vitest";
import { drainSubscriptionRunners } from "@chase-sets/bounded-context-runtime";
import {
  getApiHostSeedOrder,
  nonProductionDataProfiles,
  seedApiHostIfEmpty,
  type ApiHostRuntime,
} from "@chase-sets/platform-runtime/api";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { activateMarketplaceLabelPostage } from "@chase-sets/settlement/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import type { RecordExternalChannelSale } from "@chase-sets/inventory/server";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels/test-support";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_settlement_postage_deferral", (state) => {
  pools = state.pools;
});
const projectionName = "settlement-fulfillment-source-projection";
const projectionKey = `${projectionName}:fulfillment:v2`;
type SourceFact = {
  event_id: string;
  event_type: string;
  stream_id: string;
  stream_version: number;
  global_position: string;
  recorded_at: string;
  payload: Record<string, string | number | null>;
};

async function sourceFacts() {
  return (
    await pools.fulfillment.query<SourceFact>(`SELECT event_id, event_type, stream_id, stream_version::integer,
    global_position::text, recorded_at::text, payload FROM event_store_events ORDER BY event_store_events.global_position`)
  ).rows;
}

async function deferredState(stage: string) {
  const state = await pools.settlement.query<{
    checkpoints: string;
    applications: string;
    poisons: string;
    shipments: string;
    postage: string;
    activations: string;
  }>(
    `SELECT
    (SELECT count(*)::text FROM event_subscription_checkpoints WHERE checkpoint_key = $1) AS checkpoints,
    (SELECT count(*)::text FROM event_subscription_applications WHERE projection_key = $1) AS applications,
    (SELECT count(*)::text FROM event_projection_poison_events WHERE projection_key = $1) AS poisons,
    (SELECT count(*)::text FROM settlement_order_fulfillment_sources) AS shipments,
    (SELECT count(*)::text FROM settlement_marketplace_label_postage) AS postage,
    (SELECT count(*)::text FROM settlement_marketplace_label_postage_activation) AS activations`,
    [projectionKey],
  );
  expect(state.rows, stage).toEqual([
    { checkpoints: "0", applications: "0", poisons: "0", shipments: "0", postage: "0", activations: "0" },
  ]);
  return { stage, state: state.rows[0], sourceIds: (await sourceFacts()).map((fact) => fact.event_id) };
}

function workerFixturePorts() {
  const pricing: PricingHostPorts = {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    commercialTermsResolver: createNoopCommercialTermsResolver(),
    channelConnectionIdentityReader: { resolve: async () => null },
  };
  const channelSaleRecorder: RecordExternalChannelSale = async () => {
    throw new Error("The Settlement catch-up proof must not execute channel sales.");
  };
  return {
    ...pricing,
    channelSaleRecorder,
    inventoryCleanupAuthority: { kind: "not-mounted" } as const,
    moneyMovementGateway: createFakeMoneyMovementGateway(),
    postageLabelProvider: createSandboxPostageLabelProvider(),
    draftListingCreator: { createDraftListings: async () => [] },
    notificationAdapter: { send: async () => undefined },
    agentWebhookOrderResolvers: {
      resolveOrderRecipient: async () => null,
      resolveShipmentOrderId: async () => null,
      resolveWebhookTargets: async () => [],
    },
  };
}

async function proveBootstrapDeferral(workerPorts: ReturnType<typeof workerFixturePorts>) {
  const hostPorts = { processorGateway: createFakePaymentProcessorGateway(), listingPhotoStorage };
  const api = createPlatformApiHost({ runtimeProfile: "public", pools, hostPorts });
  expect(api.subscriptionRunners.some((runner) => runner.checkpointKey === projectionKey)).toBe(false);
  expect(api.projectionGroups.some((group) => group.projectionName === projectionName)).toBe(false);
  const stages: Awaited<ReturnType<typeof deferredState>>[] = [];
  const completedSubsteps: string[] = [];
  let currentSubstep = "";
  const log = console.log.bind(console);
  const substepLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const message = String(args[0]);
    const started = /^\[seed-api-host\] (\S+) started\.$/.exec(message);
    const completed = /^\[seed-api-host\] (\S+) completed in \d+ms\.$/.exec(message);
    if (started) currentSubstep = started[1]!;
    if (completed) completedSubsteps.push(completed[1]!);
    log(...args);
  });
  const runtime: ApiHostRuntime = {
    ...api,
    mountedContexts: api.mountedContexts.map((entry) => ({
      ...entry,
      module: {
        ...entry.module,
        ...(entry.module.seed
          ? {
              seed: async (...args: Parameters<NonNullable<typeof entry.module.seed>>) => {
                await entry.module.seed!(...args);
                stages.push(await deferredState(currentSubstep));
              },
            }
          : {}),
        ...(entry.module.reconcileBootstrapState
          ? {
              reconcileBootstrapState: async (
                ...args: Parameters<NonNullable<typeof entry.module.reconcileBootstrapState>>
              ) => {
                await entry.module.reconcileBootstrapState!(...args);
                stages.push(await deferredState(currentSubstep));
              },
            }
          : {}),
      },
    })),
  };
  const options = { enabledDataProfiles: nonProductionDataProfiles, environmentName: null };
  async function bootstrap(seedContextDrain?: true) {
    completedSubsteps.length = 0;
    const firstStage = stages.length;
    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, { ...options, seedContextDrain });
    for (const contextName of getApiHostSeedOrder(apiContextRegistry, "platform-api", undefined, options)) {
      expect(completedSubsteps, contextName).toContain(`seed:${contextName}`);
      if (stages.slice(firstStage).some((stage) => stage.stage === `seed:${contextName}`)) {
        expect(completedSubsteps, contextName).toContain(`seed-reconcile:${contextName}`);
        expect(stages.slice(firstStage).some((stage) => stage.stage === `seed-reconcile:${contextName}`)).toBe(true);
      }
    }
  }
  try {
    await bootstrap();
    stages.push(await deferredState("bootstrap-final-settle"));
    const source = await sourceFacts();
    const created = source.filter((fact) => fact.event_type === "fulfillment.shipment.created");
    const labels = source.filter((fact) => fact.event_type === "fulfillment.shipment.label-attached");
    expect(created.length).toBeGreaterThan(0);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(created.map((fact) => fact.payload.shipmentId)).size).toBe(created.length);
    await bootstrap(true);
    stages.push(await deferredState("retained-true-mode-reentry"));
    expect(await sourceFacts()).toEqual(source);
    for (let repeat = 0; repeat < 2; repeat++) {
      await bootstrap(true);
      stages.push(await deferredState(`repeat-reconcile:${repeat}`));
      expect(await sourceFacts()).toEqual(source);
    }

    // The same worker-owned activation operation runs before worker host construction.
    const activation = await activateMarketplaceLabelPostage(pools.settlement);
    const worker = createWorkerHost(apiContextRegistry, "platform-worker", {
      runtimeProfile: "public",
      pools,
      hostPorts: { ...hostPorts, ...workerPorts, marketplaceLabelPostageActivation: activation },
    });
    const runners = worker.subscriptionRunners.filter((runner) => runner.checkpointKey === projectionKey);
    expect(runners).toHaveLength(1);
    const group = worker.projectionGroups.find((group) => group.projectionName === projectionName);
    expect(group?.subscriptionRunners).toEqual(runners);
    await drainSubscriptionRunners(runners);
    const status = await runners[0]!.refreshStatus();
    expect(status.lastGlobalPosition).toBe(source.at(-1)!.global_position);
    expect(status.sourceHeadGlobalPosition).toBe(source.at(-1)!.global_position);
    expect(status.poisonEventCount).toBe(0);
    expect(status.blockedStreamCount).toBe(0);

    const shipments = (
      await pools.settlement.query<{
        shipment_id: string;
        order_id: string;
        buyer_account_id: string;
        seller_account_id: string;
        status: string;
        last_stream_version: number;
      }>(`SELECT shipment_id, order_id,
    buyer_account_id, seller_account_id, status, last_stream_version FROM settlement_order_fulfillment_sources ORDER BY shipment_id`)
    ).rows;
    const lifecycle = new Map([
      ["fulfillment.shipment.created", "created"],
      ["fulfillment.shipment.dispatched", "dispatched"],
      ["fulfillment.shipment.delivered", "delivered"],
      ["fulfillment.shipment.returned", "returned"],
      ["fulfillment.shipment.exception-raised", "exception"],
    ]);
    const expectedShipments = created
      .map((fact) => {
        const latest = source
          .filter((candidate) => candidate.stream_id === fact.stream_id && lifecycle.has(candidate.event_type))
          .at(-1)!;
        return {
          shipment_id: fact.payload.shipmentId,
          order_id: fact.payload.orderId,
          buyer_account_id: fact.payload.buyerAccountId,
          seller_account_id: fact.payload.sellerAccountId,
          status: lifecycle.get(latest.event_type),
          last_stream_version: latest.stream_version,
        };
      })
      .sort((a, b) => String(a.shipment_id).localeCompare(String(b.shipment_id)));
    expect(shipments).toEqual(expectedShipments);
    const postage = (
      await pools.settlement.query<{
        source_event_id: string;
        shipment_id: string;
        outcome: string;
        postage_amount_cents: number | null;
        postage_currency: string | null;
        debit_ledger_entry_id: string | null;
      }>(`SELECT
    source_event_id, shipment_id, outcome, postage_amount_cents, postage_currency, debit_ledger_entry_id
    FROM settlement_marketplace_label_postage ORDER BY source_event_id`)
    ).rows;
    expect(postage).toEqual(
      labels
        .map((fact) => {
          expect(Date.parse(fact.recorded_at)).toBeLessThan(Date.parse(activation.activatedAt));
          return {
            source_event_id: fact.event_id,
            shipment_id: fact.payload.shipmentId,
            outcome: "skipped-historical",
            postage_amount_cents: fact.payload.postageAmountCents,
            postage_currency: String(fact.payload.postageCurrency).toLowerCase(),
            debit_ledger_entry_id: null,
          };
        })
        .sort((a, b) => a.source_event_id.localeCompare(b.source_event_id)),
    );
    expect(await sourceFacts()).toEqual(source);
    console.log(
      JSON.stringify({
        bootstrapSequence: "fresh-full-drain -> retained-true-mode -> repeated-reconcile -> worker",
        stages,
        activation,
        sourceIds: source.map((fact) => fact.event_id),
        checkpoint: status.lastGlobalPosition,
        shipments,
        postage,
      }),
    );
  } finally {
    substepLog.mockRestore();
  }
}

describe("Settlement label postage bootstrap deferral", () => {
  it("retains fresh full-drain source history through true-mode re-entry and reconciliation until worker activation", async () => {
    await proveBootstrapDeferral(workerFixturePorts());
  }, 600_000);
});
