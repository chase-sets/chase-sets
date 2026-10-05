import { describe, expect, it } from "vitest";
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
    global_position::text, recorded_at::text, payload FROM event_store_events ORDER BY global_position`)
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

async function proveBootstrapDeferral(seedContextDrain: boolean) {
  const hostPorts = { processorGateway: createFakePaymentProcessorGateway(), listingPhotoStorage };
  const api = createPlatformApiHost({ runtimeProfile: "public", pools, hostPorts });
  expect(api.subscriptionRunners.some((runner) => runner.checkpointKey === projectionKey)).toBe(false);
  expect(api.projectionGroups.some((group) => group.projectionName === projectionName)).toBe(false);
  const stages: Awaited<ReturnType<typeof deferredState>>[] = [];
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
                stages.push(await deferredState(`seed:${entry.contextName}`));
              },
            }
          : {}),
        ...(entry.module.reconcileBootstrapState
          ? {
              reconcileBootstrapState: async (
                ...args: Parameters<NonNullable<typeof entry.module.reconcileBootstrapState>>
              ) => {
                await entry.module.reconcileBootstrapState!(...args);
                stages.push(await deferredState(`reconcile:${entry.contextName}`));
              },
            }
          : {}),
      },
    })),
  };
  const options = { enabledDataProfiles: nonProductionDataProfiles, environmentName: null, seedContextDrain };
  await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, options);
  stages.push(await deferredState("bootstrap-final-settle"));
  const source = await sourceFacts();
  const created = source.filter((fact) => fact.event_type === "fulfillment.shipment.created");
  const labels = source.filter((fact) => fact.event_type === "fulfillment.shipment.label-attached");
  expect(created.length).toBeGreaterThan(0);
  expect(labels.length).toBeGreaterThan(0);
  expect(new Set(created.map((fact) => fact.payload.shipmentId)).size).toBe(created.length);
  for (const contextName of getApiHostSeedOrder(apiContextRegistry, "platform-api")) {
    const entry = runtime.mountedContexts.find((entry) => entry.contextName === contextName)!;
    if (entry.module.seed)
      expect(
        stages.some((stage) => stage.stage === `seed:${contextName}`),
        contextName,
      ).toBe(true);
    if (entry.module.reconcileBootstrapState)
      expect(
        stages.some((stage) => stage.stage === `reconcile:${contextName}`),
        contextName,
      ).toBe(true);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, options);
    stages.push(await deferredState(`repeat-reconcile:${repeat}`));
    expect(await sourceFacts()).toEqual(source);
  }

  // The same worker-owned activation operation runs before worker host construction.
  const activation = await activateMarketplaceLabelPostage(pools.settlement);
  const worker = createWorkerHost(apiContextRegistry, "platform-worker", {
    runtimeProfile: "public",
    pools,
    hostPorts: { ...hostPorts, marketplaceLabelPostageActivation: activation },
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
      seedContextDrain,
      stages,
      activation,
      sourceIds: source.map((fact) => fact.event_id),
      checkpoint: status.lastGlobalPosition,
      shipments,
      postage,
    }),
  );
}

describe("Settlement label postage bootstrap deferral", () => {
  it("retains source history through full drains and reconciliation until worker activation", async () => {
    await proveBootstrapDeferral(false);
  }, 600_000);
  it("retains source history through context drains and reconciliation until worker activation", async () => {
    await proveBootstrapDeferral(true);
  }, 600_000);
});
