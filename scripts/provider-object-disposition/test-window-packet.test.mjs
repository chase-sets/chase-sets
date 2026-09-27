import { expect, it } from "vitest";
import { validateCapturePacket } from "./test-window-packet.mjs";
import { syntheticManifest } from "./test-window-fixtures.mjs";

const marker = "SYNTHETIC_PRIVATE_PACKET_MARKER";

it("AC-06 markers: an empty interrupted packet cannot be relabeled observed", () => {
  const value = packet();
  value.classification = "observed";
  expect(validateCapturePacket(value)).toBe(false);
});

function packet() {
  const manifest = syntheticManifest();
  return {
    version: "provider-lifecycle-capture/v1",
    classification: "invalid",
    heads: manifest.heads,
    configDigest: manifest.configuration.configDigest,
    policyDigest: manifest.configuration.policyDigest,
    deploymentEnvironment: "test",
    providerMode: "test",
    apiVersion: manifest.configuration.apiVersion,
    attempts: { scenario: 0, browser: 0, disposition: 0, total: 0, denials: [] },
    logicalCreateUpperBound: 0,
    observations: [],
    receipts: [],
    sends: [],
    lifecycle: [],
    outstandingCleanup: manifest.schedule.map(({ flow, cleanupObligations }) => ({
      flow,
      obligations: cleanupObligations,
    })),
    replayQualified: false,
  };
}

it("AC-06 markers: closed packet rejects raw fields, partials, false qualification and impossible numeric claims", () => {
  expect(validateCapturePacket(packet())).toBe(true);
  for (const mutate of [
    (p) => {
      p.raw = marker;
    },
    (p) => {
      p.heads.raw = marker;
    },
    (p) => {
      p.replayQualified = true;
    },
    (p) => {
      p.attempts.raw = marker;
    },
    (p) => {
      p.attempts.total = 1;
    },
    (p) => {
      p.attempts.browser = -1;
    },
    (p) => {
      p.attempts.denials = [{ method: marker, origin: "other", path: "other", count: 1 }];
    },
    (p) => {
      p.attempts.denials = [{ method: "GET", origin: marker, path: "other", count: 1 }];
    },
    (p) => {
      p.observations = [{ error: marker }];
    },
    (p) => {
      p.receipts = [{ raw: marker }];
    },
    (p) => {
      p.sends = [{ body: marker }];
    },
    (p) => {
      p.lifecycle = [{ error: marker }];
    },
    (p) => {
      p.outstandingCleanup[0].obligations.push(marker);
    },
    (p) => {
      p.logicalCreateUpperBound = NaN;
    },
  ]) {
    const changed = packet();
    mutate(changed);
    expect(validateCapturePacket(changed)).toBe(false);
  }
  for (const classification of ["refused", "invalid"]) {
    expect(
      validateCapturePacket({
        version: "provider-lifecycle-capture/v1",
        classification,
        code: "authority-unavailable",
        replayQualified: false,
      }),
    ).toBe(true);
    expect(
      validateCapturePacket({
        version: "provider-lifecycle-capture/v1",
        classification,
        code: marker,
        replayQualified: false,
      }),
    ).toBe(false);
  }
});
