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
    expect(input.serializedGroups).toEqual(Array(5).fill("platform-deploy-staging"));
    expect(input.serializedJobsDoNotCancel).toBe(true);
    expect(envelope).toMatchObject({
      pooled: 40,
      relays: 7,
      waiters: 8,
      bootstrap: 22,
      seed: 26,
      trigger: 75,
      limit: 94,
      phases: { rolling: 70, representative: 81, advisory: 70, bootstrap: 70 },
      productionPhases: { rolling: 55, bootstrap: 59 },
    });
    // Base #8171: the actual per-URL bootstrap maximum was four, not the
    // ledger's four-backend reservation. With concurrent advisory and seed:
    expect(40 + 7 + 8 + 21 * 4 + 25).toBe(164);
    expect(164).toBeGreaterThan(100 - 3);
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
    expect(() => enforceStagingConnectionEnvelope({ ...input, bootstrapUsesDedicatedLockPool: false })).toThrow(
      "enforced phases",
    );
    expect(() => enforceStagingConnectionEnvelope({ ...input, directUrls: 22 })).toThrow("direct URL inventory");
    expect(() => enforceStagingConnectionEnvelope({ ...input, productionPooled: 100 })).toThrow(
      "Production direct backend envelope",
    );
  });
});
