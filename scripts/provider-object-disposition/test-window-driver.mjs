import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  createPostgresEvidenceWindowRegistration,
  createEvidenceWindowCorrelation,
  createPostgresEvidenceWindowProviderWrite,
} from "../../infrastructure/platform-runtime/control-plane.ts";
import { createStripePaymentProcessorGateway } from "../../infrastructure/stripe-payments/index.ts";
import { createStripeConnectMoneyMovementGateway } from "../../infrastructure/stripe-connect/index.ts";
import { createEvidenceWindowDisposition } from "../../bounded-contexts/payments/features/payments/api/evidence-window-disposition.ts";
import { STRIPE_API_VERSION } from "../../infrastructure/stripe-config/index.ts";
import { createAttemptBudget } from "./test-window-policy.mjs";
import { createServerFence } from "./test-window-server.mjs";
import { observeConnectComponent } from "./test-window-browser.mjs";
import { isUnrestrictedStripeSecretKeyForMode } from "../stripe-key-mode.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function createTestWindowDriver(
  manifest,
  { pool, secretKey, fixtures, browser, send = globalThis.fetch, authoritySignal },
) {
  authoritySignal?.throwIfAborted();
  if (
    manifest.configuration.apiVersion !== STRIPE_API_VERSION ||
    !isUnrestrictedStripeSecretKeyForMode(secretKey, "test") ||
    !/^[a-z]+_[a-z]+_[A-Za-z0-9_]+$/.test(secretKey)
  )
    throw new Error("authority-unavailable");
  const controller = new AbortController();
  const scenarioController = new AbortController();
  const stopBrowser = () => {
    scenarioController.abort();
    void browser.close().catch(() => {});
  };
  const expireAuthority = () => {
    controller.abort();
    stopBrowser();
  };
  authoritySignal?.addEventListener("abort", expireAuthority, { once: true });
  const budget = createAttemptBudget({
    expiresAt: manifest.timing.expiresAt,
    cleanupSeconds: manifest.timing.cleanupSeconds,
    limits: {
      scenario: manifest.budgets.scenario,
      browser: manifest.budgets.browser,
      disposition: manifest.budgets.disposition,
    },
    abort: stopBrowser,
  });
  const registration = createPostgresEvidenceWindowRegistration(pool);
  const journal = createPostgresEvidenceWindowProviderWrite(pool);
  const fence = createServerFence({
    journal,
    configuration: manifest.configuration,
    fixtures,
    budget,
    send,
    signal: controller.signal,
    scenarioSignal: scenarioController.signal,
    maxObjects: manifest.budgets.objects,
  });
  const originalFetch = globalThis.fetch;
  const gateways = () => {
    // Fresh gateways and a fresh J adapter share only the persisted PostgreSQL
    // history. No transient successful response is supplied to the executor.
    const journal = createPostgresEvidenceWindowProviderWrite(pool);
    const options = {
      secretKey,
      webhookSecret: "",
      evidenceWindowCorrelation: createEvidenceWindowCorrelation(createPostgresEvidenceWindowRegistration(pool)),
      evidenceWindowProviderWrite: journal,
    };
    return {
      payments: createStripePaymentProcessorGateway({ ...options, publishableKey: fixtures.publishableKey }),
      connect: createStripeConnectMoneyMovementGateway({ ...options, accountsApi: "v2" }),
      journal,
    };
  };
  const paymentInput = {
    paymentId: fixtures.paymentId,
    buyerAccountId: fixtures.buyerB,
    orderIds: fixtures.orderIds,
    amount: fixtures.amount,
    currencyCode: "usd",
    paymentMethodCategory: "card",
    description: "Provider lifecycle evidence",
    providerCustomerReference: fixtures.customerB,
    savedCheckoutInstrument: {
      instrumentId: fixtures.instrumentId,
      providerCustomerReference: fixtures.customerB,
      providerReference: fixtures.paymentMethod,
      confirmationExperience: "off-session-token",
    },
  };
  const setupInput = {
    setupReferenceId: fixtures.setupReferenceId,
    accountId: fixtures.buyerB,
    providerCustomerReference: fixtures.customerB,
    uiMode: "embedded",
    currencyCode: "usd",
    consentId: fixtures.consentId,
    consentText: fixtures.consentText,
  };
  const membership = (mapper) => ({
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
      mapper === "customer" ? fixtures.buyerA : mapper.startsWith("connect-") ? fixtures.seller : fixtures.buyerB,
  });
  const lifecycle = [];
  const groups = manifest.schedule.map((flow) => {
    let opened;
    const members = flow.mappers.map(membership);
    if (hash(JSON.stringify(members)) !== flow.identityDigest) throw new Error("fixture-binding");
    const activate = (mapper, phase) => fence.activate({ mapper, phase, windowId: flow.windowId, members });
    const run = (mapper) => {
      const { payments, connect } = gateways();
      if (mapper === "customer") return payments.createCustomer({ accountId: fixtures.buyerA });
      if (mapper === "setup-embedded") return payments.createSetupSession(setupInput);
      if (mapper === "payment-saved") return payments.createPaymentSession(paymentInput);
      const input = {
        accountId: fixtures.seller,
        providerReference: fixtures.connectedAccount,
        idempotencyKey: "unused-governed-input",
        evidenceWindowSlot: flow.slots[0],
      };
      if (mapper === "connect-setup") return connect.createPayoutSetupSession(input);
      if (mapper === "connect-manage") return connect.createPayoutAccountManagementSession(input);
      return connect.createPayoutNotificationBannerSession(input);
    };
    const scenarios = flow.mappers.map((mapper) => {
      let replay;
      let customer;
      return {
        mapper,
        activate: async (phase) => activate(mapper, phase),
        original: () => run(mapper),
        waitForReplay: () =>
          delay(manifest.timing.replaySeconds * 1000, undefined, { signal: scenarioController.signal }),
        restartAndReplay: async () => {
          replay = await run(mapper);
          if (mapper === "customer") customer = replay;
        },
        repeatSameSlot: () => run(mapper),
        reuse: async () => {
          if (!customer) throw new Error("customer-unobserved");
          const repeated = await run(mapper);
          if (repeated.providerCustomerReference !== customer.providerCustomerReference)
            throw new Error("customer-mismatch");
          const rows = await journal.readWindow(flow.windowId);
          if (rows.filter((row) => row.key.operation === "create" && row.key.objectClass === 5).length !== 1)
            throw new Error("customer-count");
        },
        initializeIntendedComponent: async () => {
          const names = {
            "connect-setup": "account-onboarding",
            "connect-manage": "account-management",
            "connect-notification": "notification-banner",
          };
          if (!replay?.clientSecret || !replay.expiresAt || Date.parse(replay.expiresAt) <= Date.now())
            return { component: names[mapper], attempted: false, outcome: "unknown", usability: "unknown" };
          return observeConnectComponent({
            browser,
            mapper,
            publishableKey: fixtures.publishableKey,
            clientSecret: replay.clientSecret,
            expiresAt: replay.expiresAt,
            deadlineAt: new Date(
              Math.min(
                Date.now() + manifest.timing.observationSeconds * 1000,
                Date.parse(manifest.timing.expiresAt) - manifest.timing.cleanupSeconds * 1000,
              ),
            ).toISOString(),
            budget,
            send,
            signal: scenarioController.signal,
          });
        },
      };
    });
    const disposition = (policy) => {
      const fresh = gateways();
      return createEvidenceWindowDisposition({
        processorGateway: fresh.payments,
        journal: fresh.journal,
        providerModeObservation: {
          mode: "test",
          deploymentEnvironment: manifest.configuration.deploymentEnvironment,
          paymentProcessorKind: "stripe",
          moneyMovementKind: "stripe",
        },
        authority: async () => ({
          windowId: flow.windowId,
          expiresAt: manifest.timing.expiresAt,
          providerMode: "test",
        }),
      })(flow.windowId, policy);
    };
    return {
      flow: flow.flow,
      windowId: flow.windowId,
      scenarios,
      open: async () => {
        budget.assert("scenario");
        opened = await registration.open({ windowId: flow.windowId, retentionSeconds: 3600 });
      },
      dispose: async (policy) => {
        activate(null, "disposition");
        // The P flow attempts eligible concurrent cancellation, withheld response,
        // fresh-J reconciliation and a terminal repeat against the same objects.
        if (flow.flow === "P") {
          const rivals = await Promise.allSettled([disposition(policy), disposition(policy)]);
          lifecycle.push({
            flow: flow.flow,
            stage: "concurrent-cancel",
            outcomes: rivals.map((result) => (result.status === "fulfilled" ? result.value.variant : "unknown")),
          });
        }
        const receipt = await disposition(policy);
        const before = fence.observations().length;
        const repeat = await disposition(policy);
        lifecycle.push({
          flow: flow.flow,
          stage: "terminal-repeat",
          postCount: fence.observations().length - before,
          outcome: repeat.variant,
        });
        return receipt;
      },
      close: async () => {
        await registration.close({ windowId: flow.windowId, expectedVersion: opened.version });
      },
    };
  });
  globalThis.fetch = fence.fetch;
  const timer = setTimeout(
    () => {
      controller.abort();
      stopBrowser();
    },
    Math.max(0, Date.parse(manifest.timing.expiresAt) - Date.now()),
  );
  const scenarioTimer = setTimeout(
    stopBrowser,
    Math.max(0, Date.parse(manifest.timing.expiresAt) - manifest.timing.cleanupSeconds * 1000 - Date.now()),
  );
  return {
    journal,
    groups,
    counts: () => budget.snapshot(),
    sends: () => fence.observations(),
    lifecycle: () => structuredClone(lifecycle),
    creationCount: () => fence.creationCount(),
    dispose: async () => {
      authoritySignal?.removeEventListener("abort", expireAuthority);
      clearTimeout(timer);
      clearTimeout(scenarioTimer);
      controller.abort();
      stopBrowser();
      globalThis.fetch = originalFetch;
      await browser.close();
    },
  };
}
