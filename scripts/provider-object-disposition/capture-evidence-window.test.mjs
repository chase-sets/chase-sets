import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { captureEvidenceWindow } from "./capture-evidence-window.mjs";
import { SCENARIO_FIXTURES } from "./validate-provider-object-disposition.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const marker = "SYNTHETIC_PRIVATE_MARKER";
const admission = {
  deploymentEnvironment: "test",
  providerMode: "test",
  reviewedHead: "a".repeat(40),
  executedHead: "a".repeat(40),
  journalHead: "b".repeat(40),
  deployedHead: "c".repeat(40),
  expiresAt: "2099-01-01T00:00:00Z",
  apiVersion: "2026-01-28.clover",
  configDigest: "d".repeat(64),
  maxHttpAttempts: 32,
  maxObjects: 6,
};

function launch(patch = {}) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ id: `pi_${marker}`, livemode: false, client_secret: marker, expires_at: 4070908800 });
  };
  const mappers = [
    "customer",
    "setup-embedded",
    "payment-saved",
    "connect-setup",
    "connect-manage",
    "connect-notification",
  ];
  const endpoints = [
    "customers",
    "setup_intents",
    "payment_intents",
    "account_sessions",
    "account_sessions",
    "account_sessions",
  ];
  const objectClasses = [5, 3, 2, 6, 6, 6];
  const ordinals = [1, 1, 1, 1, 2, 3];
  const scenarios = mappers.map((mapper, index) => {
    const send = () =>
      fetch(`https://api.stripe.com/v1/${endpoints[index]}`, {
        method: "POST",
        body: `private=${marker}`,
        headers: {
          "Stripe-Version": admission.apiVersion,
          "Idempotency-Key": `evidence-window/v1:${"a".repeat(32)}:${objectClasses[index]}:${ordinals[index]}:create`,
        },
      });
    return {
      mapper,
      original: send,
      restartAndReplay: send,
      repeatSameSlot: send,
      twoTabs: () => Promise.all([send(), send()]),
      initializeIntendedComponent: async () => true,
    };
  });
  const journal = {
    readWindow: async (windowId) =>
      mappers.map((mapper, index) => ({
        key: { windowId, objectClass: objectClasses[index], creationOrdinal: ordinals[index], operation: "create" },
        binding: { writerKind: mapper },
        state: "pending",
        replayDeadline: admission.expiresAt,
        envelope: {
          endpoint: `/v1/${endpoints[index]}`,
          method: "POST",
          bodyText: `private=${marker}`,
          apiVersion: admission.apiVersion,
          connectedAccountReference: null,
        },
      })),
  };
  return {
    requests,
    scenarios,
    admit: async () => ({ ...admission, ...patch }),
    open: async () => ({
      scenarios,
      journal,
      dispose: async () => structuredClone(SCENARIO_FIXTURES.cleanupFailureOverBudget),
    }),
  };
}

test("AC-08: synthetic accepted-response withholding, replay comparison and usability are not live qualification", async () => {
  const driver = launch();
  const packet = await captureEvidenceWindow(driver);
  assert.equal(driver.requests.length, 21);
  assert.equal(packet.actualHttpAttempts, 21);
  assert.equal(packet.actualLogicalCreations, 6);
  assert.equal(packet.replayQualified, false);
  assert.equal(packet.observations.length, 6);
  assert.ok(packet.observations.every((observation) => observation.equal && !observation.intervalSupported));
  assert.ok(packet.observations.slice(3).every((observation) => observation.usability === "usable"));
  assert.ok(packet.observations.slice(3).every((observation) => observation.repeatedSameSlot && observation.twoTabs));
  assert.ok(!JSON.stringify(packet).includes(marker));
});

test("AC-07: production and malformed authority cannot open provider composition", async () => {
  for (const patch of [
    { deploymentEnvironment: "production" },
    { providerMode: "live" },
    { executedHead: "e".repeat(40) },
    { maxObjects: 0 },
  ]) {
    const driver = launch(patch);
    driver.open = async () => {
      assert.fail("provider composition was reached");
    };
    assert.equal((await captureEvidenceWindow(driver)).classification, "refused");
    assert.equal(driver.requests.length, 0);
  }
  assert.equal((await captureEvidenceWindow()).code, "authority-unavailable");
});

test("AC-08: finite attempts and missing mapper fail closed, never invent replay observations", async () => {
  const bounded = launch({ maxHttpAttempts: 1 });
  const packet = await captureEvidenceWindow(bounded);
  assert.equal(bounded.requests.length, 1);
  assert.equal(packet.replayQualified, false);
  assert.ok(packet.observations.every((observation) => !observation.equal));
  const omitted = launch();
  omitted.scenarios.pop();
  assert.equal((await captureEvidenceWindow(omitted)).code, "invalid-input");
  assert.equal(omitted.requests.length, 0);
});

test("AC-06/AC-08: unusable components and private exceptions remain bounded unknown", async () => {
  const driver = launch();
  driver.scenarios[3].initializeIntendedComponent = async () => {
    throw new Error(marker);
  };
  const packet = await captureEvidenceWindow(driver);
  assert.equal(packet.observations[3].classification, "unknown");
  assert.equal(packet.observations[3].usability, "unknown");
  assert.equal(packet.replayQualified, false);
  assert.ok(!JSON.stringify(packet).includes(marker));
});
