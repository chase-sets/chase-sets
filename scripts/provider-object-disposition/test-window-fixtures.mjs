import { createHash } from "node:crypto";
import { POLICY_DIGEST, WINDOW_SCHEDULE, configurationDigest } from "./test-window-policy.mjs";
import { STRIPE_API_VERSION } from "../../infrastructure/stripe-config/index.ts";
import { STRIPE_KEY_CASES } from "../stripe-key-mode.mjs";

export const syntheticHash = (value) => createHash("sha256").update(value).digest("hex");
export const SYNTHETIC_FIXTURES = Object.freeze({
  buyerA: "acc_SYNTHETIC_A",
  buyerB: "acc_SYNTHETIC_B",
  seller: "acc_SYNTHETIC_SELLER",
  customerB: "cus_SYNTHETIC_6733_B",
  connectedAccount: "acct_SYNTHETIC_6733",
  paymentMethod: "pm_SYNTHETIC_6733",
  publishableKey: `${STRIPE_KEY_CASES.find((entry) => entry.family === "publishable" && entry.mode === "test").prefix}SYNTHETIC_6733`,
  paymentId: "pay_SYNTHETIC",
  setupReferenceId: "scs_SYNTHETIC",
  instrumentId: "instrument_SYNTHETIC",
  orderIds: ["ord_SYNTHETIC"],
  amount: "1.00",
  consentId: "consent_SYNTHETIC",
  consentText: "Synthetic setup consent",
});

export function syntheticManifest(now = Date.now()) {
  const fixtures = SYNTHETIC_FIXTURES;
  const manifest = {
    version: "provider-test-window/v1",
    heads: { candidate: "a".repeat(40), executor: "a".repeat(40), journal: "a".repeat(40), deployed: "b".repeat(40) },
    proof: {
      reviewedHead: "a".repeat(40),
      reviewDigest: "c".repeat(64),
      ciHead: "a".repeat(40),
      ciRunId: 1,
      ciConclusion: "success",
      dbConclusion: "success",
      redactionAccepted: true,
    },
    configuration: {
      deploymentEnvironment: "test",
      providerMode: "test",
      accountsApi: "v2",
      apiVersion: STRIPE_API_VERSION,
      configVersion: "a".repeat(40),
      policyVersion: "a".repeat(40),
      configDigest: "d".repeat(64),
      policyDigest: POLICY_DIGEST,
      sdkVersion: "3.4.5",
    },
    schedule: WINDOW_SCHEDULE.map((flow, index) => ({
      flow: flow.flow,
      windowId: (index + 1).toString().repeat(32),
      identityDigest: syntheticHash(
        JSON.stringify(
          flow.mappers.map((mapper) => ({
            writerKind: mapper,
            logicalOperationId:
              mapper === "customer"
                ? fixtures.buyerA
                : mapper === "setup-embedded"
                  ? fixtures.setupReferenceId
                  : mapper === "payment-saved"
                    ? fixtures.paymentId
                    : fixtures.seller,
            ownerAccountId:
              mapper === "customer"
                ? fixtures.buyerA
                : mapper.startsWith("connect-")
                  ? fixtures.seller
                  : fixtures.buyerB,
          })),
        ),
      ),
      mappers: [...flow.mappers],
      slots: index === 0 ? [] : [index],
      cleanupObligations:
        index === 0
          ? ["retain-customer", "cancel-eligible-intents", "retain-captured-remedy"]
          : ["retain-session-expiry"],
    })),
    fixturesDigest: syntheticHash(JSON.stringify(fixtures)),
    budgets: { scenario: 128, browser: 128, disposition: 64, objects: 6, class6PerWindow: 2 },
    timing: {
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 600000).toISOString(),
      credentialExpiresAt: new Date(now + 600000).toISOString(),
      replaySeconds: 5,
      observationSeconds: 1,
      cleanupSeconds: 30,
      retentionSeconds: 3600,
      retentionSource: "https://docs.stripe.com/api/idempotent_requests",
    },
    paths: {
      claim: process.platform === "win32" ? "C:\\synthetic-authority\\claim" : "/tmp/synthetic-authority/claim",
      packetDirectory:
        process.platform === "win32" ? "C:\\synthetic-authority\\packet" : "/tmp/synthetic-authority/packet",
    },
    journal: {
      host: "127.0.0.1",
      port: 15432,
      database: `provider_window_${"e".repeat(32)}`,
      user: "synthetic",
      isolated: true,
      shared: false,
      environment: "local",
    },
    noRetry: true,
  };
  manifest.configuration.configDigest = configurationDigest(manifest.configuration);
  return manifest;
}
