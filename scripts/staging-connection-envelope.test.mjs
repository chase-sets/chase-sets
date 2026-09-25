import { describe, expect, it } from "vitest";
import {
  enforceStagingConnectionEnvelope,
  loadStagingConnectionEnvelopeInputs,
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
    expect(input.serializedGroups).toEqual(Array(5).fill("platform-deploy-staging"));
    expect(input.serializedJobsDoNotCancel).toBe(true);
    expect(input.advisoryAwaitsSeedJobTermination).toBe(true);
    expect(input.advisoryResumesWorkerBeforeRbacRemoval).toBe(true);
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
      phases: { rolling: 74, representative: 85, advisory: 70, bootstrap: 70 },
      productionPhases: { rolling: 57, bootstrap: 59 },
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
      "until its Kubernetes Job terminates",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, advisoryResumesWorkerBeforeRbacRemoval: false })).toThrow(
      "until its Kubernetes Job terminates",
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
});
