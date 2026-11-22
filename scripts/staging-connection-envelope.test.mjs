import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enforceStagingConnectionEnvelope,
  loadStagingConnectionEnvelopeInputs,
  pendingRegistrationLockAllowanceLedgerRow,
} from "./staging-connection-envelope.mjs";

describe("staging aggregate direct backend envelope", () => {
  it("bounds the actual Job pools and separates rollout, seed, and quiesced bootstrap phases", () => {
    const input = loadStagingConnectionEnvelopeInputs();
    const envelope = enforceStagingConnectionEnvelope(input);

    expect(input.directUrls).toBe(21);
    expect(input.bootstrapPoolMax).toBe(1);
    expect(input.scenarioPoolMax).toBe(1);
    expect(input.seedPoolsCapped).toBe(true);
    expect(input.workerSettlementBootstrapPoolMax).toBe(1);
    expect(input.workerMaxConcurrentStarts).toBe(4);
    expect(input.productionWorkerMaxConcurrentStarts).toBe(2);
    expect(input.workerSettlementBootstrapBound).toBe(true);
    expect(input.bootstrapUsesFullSpanLock).toBe(true);
    expect(input.serializedGroups).toEqual([
      "platform-staging-advisory-evidence",
      ...Array(4).fill("platform-deploy-staging"),
    ]);
    expect(input.serializedJobsDoNotCancel).toBe(true);
    expect(input.advisoryAwaitsSeedJobTermination).toBe(true);
    expect(input.advisoryResumesWorkerBeforeRbacRemoval).toBe(true);
    expect(input.lockPoolMax).toBe(2);
    expect(input.stagingApiReplicas).toBe(2);
    expect(input.productionApiReplicas).toBe(1);
    expect(input.allowance).toMatchObject({ name: "Auth pending-registration direct locks", verified: true });
    expect(envelope).toMatchObject({
      pooled: 40,
      relays: 7,
      waiters: 8,
      bootstrap: 22,
      seed: 26,
      trigger: 75,
      limit: 94,
      workerMaxConcurrentStarts: 4,
      productionWorkerMaxConcurrentStarts: 2,
      allowance: "Auth pending-registration direct locks",
      locks: { poolMax: 2, apiReplicas: 2, steady: 4, rolling: 8 },
      nonLockPhases: { steady: 55, rolling: 74, representative: 85, advisory: 70, bootstrap: 70 },
      phases: { steady: 59, rolling: 82, representative: 89, advisory: 74, bootstrap: 74 },
      headroom: { steady: 35, rolling: 12, representative: 5, advisory: 20, bootstrap: 20 },
      rollingTriggerHeadroom: 1,
      productionLocks: { poolMax: 2, apiReplicas: 1, steady: 2, rolling: 4 },
      nonLockProductionPhases: { steady: 44, rolling: 57, bootstrap: 59 },
      productionPhases: { steady: 46, rolling: 61, bootstrap: 61 },
      productionHeadroom: { steady: 48, rolling: 33, bootstrap: 33 },
      productionRollingTriggerHeadroom: 14,
      productionListenerExpansion: { additionalRollingDemand: 6, rolling: 67, fitsTrigger: true, fitsLimit: true },
    });
    // Base 573d1a15 had a per-URL bootstrap maximum of four; even with
    // phase exclusion, 40 pooled + 8 waiters + (21 * 4 + 1 lock) = 133.
    expect(() => enforceStagingConnectionEnvelope({ ...input, bootstrapPoolMax: 4, scenarioPoolMax: 4 })).toThrow(
      "exceeds its tier trigger or hard budget",
    );
  });

  it("rejects an uncapped Job and lost phase exclusions rather than warning", () => {
    const input = loadStagingConnectionEnvelopeInputs();
    expect(() => enforceStagingConnectionEnvelope({ ...input, bootstrapPoolMax: 4, scenarioPoolMax: 4 })).toThrow(
      "exceeds its tier trigger or hard budget",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, serializedGroups: ["other"] })).toThrow(
      "enforced phases",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, serializedJobsDoNotCancel: false })).toThrow(
      "enforced phases",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, scenarioQuiescesWorkers: false })).toThrow(
      "enforced phases",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, advisoryAwaitsSeedJobTermination: false })).toThrow(
      "await its Job termination",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, advisoryResumesWorkerBeforeRbacRemoval: false })).toThrow(
      "await its Job termination",
    );
    for (const guard of [
      "scenarioRestoresWorkers",
      "bootstrapQuiescesWorkers",
      "bootstrapBeforeRollout",
      "dispatchesWithinDeploy",
    ]) {
      expect(() => enforceStagingConnectionEnvelope({ ...input, [guard]: false })).toThrow("enforced phases");
    }
    expect(() => enforceStagingConnectionEnvelope({ ...input, bootstrapUsesDedicatedLockPool: false })).toThrow(
      "enforced phases",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, seedPoolsCapped: false })).toThrow("enforced phases");
    expect(() => enforceStagingConnectionEnvelope({ ...input, workerSettlementBootstrapBound: false })).toThrow(
      "worker Settlement bootstrap",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, workerSettlementBootstrapPoolMax: 13 })).toThrow(
      "tier trigger",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, workerSettlementBootstrapPoolMax: 2 })).toThrow(
      '"rolling":78',
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, workerMaxConcurrentStarts: 6 })).toThrow('"rolling":76');
    for (const workerMaxConcurrentStarts of [0, NaN, 1.5]) {
      expect(() => enforceStagingConnectionEnvelope({ ...input, workerMaxConcurrentStarts })).toThrow(
        "worker Settlement bootstrap",
      );
    }
    expect(() => enforceStagingConnectionEnvelope({ ...input, productionWorkerMaxConcurrentStarts: 0 })).toThrow(
      "worker Settlement bootstrap",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, directUrls: 22 })).toThrow("direct URL inventory");
    expect(() => enforceStagingConnectionEnvelope({ ...input, productionPooled: 100 })).toThrow(
      "Production direct backend envelope",
    );
  });

  it("admits staging rolling demand above the trigger only through the named Auth lock allowance", () => {
    const input = loadStagingConnectionEnvelopeInputs();
    const enforce = (overrides) => () => enforceStagingConnectionEnvelope({ ...input, ...overrides });

    // A third lock connection per API process: 12 rolling locks exceed the allowance's 8.
    expect(enforce({ lockPoolMax: 3 })).toThrow('"locks":{"steady":6,"rolling":12}');
    // An extra API replica raises the same lock demand.
    expect(enforce({ stagingApiReplicas: 3 })).toThrow('"locks":{"steady":6,"rolling":12}');
    for (const lockPoolMax of [NaN, 0, 1.5]) {
      expect(enforce({ lockPoolMax })).toThrow("verified factory cap");
    }
    expect(enforce({ productionApiReplicas: 0 })).toThrow("positive canonical API replicas");

    // 75 non-lock + 8 locks = 83 exceeds the 82 rolling total.
    expect(enforce({ workerMaxConcurrentStarts: 5 })).toThrow('"rolling":83');
    // 76 non-lock rolling is refused even with only 4 lock backends (80 total).
    expect(enforce({ workerMaxConcurrentStarts: 6, lockPoolMax: 1 })).toThrow('"rolling":76');
    // A two-connection bootstrap Job puts the bootstrap phase at 95.
    expect(enforce({ bootstrapPoolMax: 2, scenarioPoolMax: 2 })).toThrow('"bootstrap":95');

    expect(enforce({ allowance: null })).toThrow("no allowance");
    expect(enforce({ allowance: { ...input.allowance, verified: false } })).toThrow("allowance is unverified");
    expect(enforce({ allowance: { ...input.allowance, name: "Auth direct locks" } })).toThrow(
      "allowance is unverified",
    );
    expect(enforce({ allowance: { ...input.allowance, maxRollingTotal: 83 } })).toThrow("allowance is unverified");
    expect(enforce({ allowance: { ...input.allowance, maxLockBackends: 0 } })).toThrow(
      "must bound counted lock backends",
    );
    expect(enforce({ allowance: { ...input.allowance, environment: "production" } })).toThrow("staging-only");

    // Without the allowance, staging rolling must fit under the trigger, locks included.
    expect(
      enforceStagingConnectionEnvelope({ ...input, allowance: null, lockPoolMax: 1, workerMaxConcurrentStarts: 1 }),
    ).toMatchObject({ allowance: null, phases: { rolling: 75 } });
    expect(enforce({ allowance: null, lockPoolMax: 1, workerMaxConcurrentStarts: 2 })).toThrow("no allowance");
  });

  it("verifies the allowance only against its exact connection-ledger row", () => {
    const row = pendingRegistrationLockAllowanceLedgerRow();
    expect(row).toBe(
      "| Auth pending-registration direct locks | staging only | non-lock rolling ≤ 75, locks ≤ 8, rolling total ≤ 82, every phase ≤ the tier limit |",
    );
    expect(readFileSync(resolve("docs/architecture/push-wake-connection-budget.md"), "utf8")).toContain(row);
    expect(
      pendingRegistrationLockAllowanceLedgerRow({
        name: "Auth pending-registration direct locks",
        environment: "staging",
        maxLockBackends: 8,
        maxNonLockRolling: 75,
        maxRollingTotal: 83,
      }),
    ).not.toBe(row);
  });
});
