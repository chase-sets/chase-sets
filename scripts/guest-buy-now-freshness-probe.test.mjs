import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READY_SLO_MS,
  GUEST_BUY_NOW_FRESHNESS_PROBE_VERSION,
  PRODUCTION_FEASIBILITY_DECISION,
  SEGMENT_METRIC_REFERENCES,
  accountBuyNowActionFormForCandidate,
  assertRedactedEvidence,
  buildGuestBuyNowProbeEvidence,
  buyNowItemPageNavigationWaitOptions,
  buyNowRouteTransitionWaitOptions,
  classifyGuestBuyNowObservation,
  detectFreshWriteMetadata,
  evaluateProjectionConvergence,
  evaluateWakeRuntimeReadiness,
  fetchProjectionStatusSnapshot,
  isCheckoutSessionDocumentResponseUrl,
  isBuyReadinessUrl,
  isBuySessionUrl,
  parseGuestBuyNowProbeArgs,
  resolveGuestBuyNowItemCandidates,
  resolveGuestBuyNowItemPath,
  runGuestBuyNowFreshnessProbe,
  runProjectionConvergenceGate,
  startAccountSession,
  submitAccountBuyNowActionFallback,
  validateGuestBuyNowProbeOptions,
  waitForProjectionConvergence,
  waitForWakeRuntimePreflight,
  SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON,
} from "./guest-buy-now-freshness-probe.mjs";

const execFileAsync = promisify(execFile);

const baseOptions = {
  checkedAt: "2026-06-09T16:00:00.000Z",
  environment: "staging",
  fixtureKey: "staging-charizard-canary",
  diagnosticCorrelationId: "diag_123",
};

const healthyProbe = {
  attempted: true,
  documentStatus: 401,
  permanentRecoveryVisible: true,
  temporaryRecoveryVisible: false,
  checkoutReviewVisible: false,
  platformErrorVisible: false,
};

const readyWakeStatusSnapshot = {
  schedulers: { available: true, activeWakeCapableWorkerCount: 2 },
  relay: { available: true, lease: { state: "active", ownerId: "worker-1" } },
};

const unreadyWakeStatusSnapshot = {
  schedulers: { available: true, activeWakeCapableWorkerCount: 0 },
  relay: { available: true, lease: { state: "standby", ownerId: null } },
};

const convergedProjectionStatusSnapshot = {
  projectionGroups: [
    { projectionName: "checkout.session-projection", caughtUp: true, state: "caught-up" },
    { projectionName: "auth-identity-invitation-projection", caughtUp: true, state: "idle" },
  ],
};

const laggingProjectionStatusSnapshot = {
  projectionGroups: [
    { projectionName: "checkout.session-projection", caughtUp: true, state: "caught-up" },
    { projectionName: "auth-identity-invitation-projection", caughtUp: false, state: "behind" },
  ],
};

const observedRun29666002029ProjectionStatusSnapshot = {
  projectionGroups: [
    { projectionName: "checkout.session-projection", caughtUp: true, state: "caught-up" },
    { projectionName: "auth-session-projection", caughtUp: false, state: "behind", outstandingEventCount: "1" },
    {
      projectionName: "auth-session-transactional-email-projection",
      caughtUp: false,
      state: "behind",
      outstandingEventCount: "1",
    },
    {
      projectionName: "collections-catalog-product-projection",
      caughtUp: false,
      state: "degraded",
      outstandingEventCount: "0",
      blockedStreamCount: 8,
    },
  ],
};

class FakeResponse {
  constructor(statusCode, body = {}, responseHeaders = {}) {
    this.statusCode = statusCode;
    this.body = body;
    this.responseHeaders = responseHeaders;
  }

  status() {
    return this.statusCode;
  }

  async json() {
    return this.body;
  }

  headers() {
    return this.responseHeaders;
  }
}

function createFakeAccountSessionPage(route) {
  const calls = [];
  const cookies = [];
  const page = {
    request: {
      post: vi.fn(async (url, options = {}) => {
        const call = { method: "POST", url, headers: options.headers, data: options.data };
        calls.push(call);
        return route(call);
      }),
      get: vi.fn(async (url, options = {}) => {
        const call = { method: "GET", url, headers: options.headers };
        calls.push(call);
        return route(call);
      }),
    },
    waitForTimeout: vi.fn(async () => undefined),
  };
  const context = {
    addCookies: vi.fn(async (newCookies) => {
      cookies.push(...newCookies);
    }),
  };
  return { calls, context, cookies, page };
}

function commitReceiptFor(sources) {
  return encodeURIComponent(JSON.stringify(sources));
}

function createFakeGuestEntryBrowser(entries, options = {}) {
  const baseUrl = "https://marketplace.staging.chasesets.com";
  const handlers = new Map();
  const eventLog = [];
  let currentUrl = `${baseUrl}/items/canary`;
  let pageText = "";
  const mainFrame = { url: () => currentUrl };
  const body = {
    innerText: vi.fn(async () => pageText),
  };
  const buyNowButton = {
    click: vi.fn(async () => {
      eventLog.push("click-buy-now");
      options.onClick?.();
      const entry = entries.shift();
      if (!entry) {
        throw new Error("Fake guest entry browser has no remaining entry outcome.");
      }

      const readinessUrl = `${baseUrl}/checkout/buy/readiness?source=buy-now`;
      handlers.get("response")?.({
        request: () => ({ resourceType: () => "document" }),
        status: () => (entry.kind === "session" ? 307 : 200),
        url: () => readinessUrl,
      });
      eventLog.push(`response-readiness-${entry.kind === "session" ? 307 : 200}`);

      if (entry.kind === "session") {
        currentUrl = `${baseUrl}/checkout/buy/session/chk_test?afterWrite=redacted`;
        pageText = "Checkout Summary Continue to payment Payable total";
        handlers.get("response")?.({
          request: () => ({ resourceType: () => "document" }),
          status: () => 200,
          url: () => currentUrl,
        });
        eventLog.push("response-session-200");
      } else {
        currentUrl = readinessUrl;
        pageText = entry.pageText ?? "";
      }

      handlers.get("framenavigated")?.(mainFrame);
      eventLog.push(`committed-${entry.kind === "session" ? "session" : "readiness"}`);
    }),
  };
  const getByLabel = vi.fn(() => {
    throw new Error("The shipped guest entry has no entry-time contact field.");
  });
  const getByRole = vi.fn(() => {
    throw new Error("The shipped guest entry has no entry-time guest continuation control.");
  });
  const page = {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    mainFrame: () => mainFrame,
    url: () => currentUrl,
    goto: vi.fn(async (url) => {
      currentUrl = url;
      pageText = "";
      eventLog.push("load-item");
    }),
    locator: vi.fn((selector) => (selector === "body" ? body : { first: () => buyNowButton })),
    getByLabel,
    getByRole,
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
  };
  const context = {
    newPage: vi.fn(async () => page),
    cookies: vi.fn(async () =>
      options.guestCookiePresent === false ? [] : [{ name: "chase_sets_guest_checkout", value: "redacted" }],
    ),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };

  return {
    body,
    browser,
    buyNowButton,
    eventLog,
    getByLabel,
    getByRole,
    launchBrowser: vi.fn(async () => browser),
  };
}

function guestEntryOptions(fakeBrowser, overrides = {}) {
  return {
    baseUrl: "https://marketplace.staging.chasesets.com",
    itemPath: "/items/canary",
    fixtureKey: "canary-fixture",
    guestEmail: "guest-buy-now-canary@example.test",
    contactName: "Guest Buy Now Probe",
    environment: "staging",
    checkedAt: baseOptions.checkedAt,
    diagnosticCorrelationId: "diag_123",
    skipNegativeProbe: true,
    maxAttempts: 1,
    launchBrowser: fakeBrowser.launchBrowser,
    ...overrides,
  };
}

describe("guest Buy Now freshness probe", () => {
  it("classifies pay-ready checkout inside the readiness SLO as promote", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 1800,
        negativeProbe: healthyProbe,
      }),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    });
  });

  it("warns by default when checkout readiness exceeds the interim SLO", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: true,
          checkoutReviewVisible: true,
          readyLatencyMs: 14_000,
          negativeProbe: healthyProbe,
        },
        { readySloMs: 10_000 },
      ),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "warn",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("aborts promotion on SLO breach when slo-mode is gate", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: true,
          checkoutReviewVisible: true,
          readyLatencyMs: 14_000,
          negativeProbe: healthyProbe,
        },
        { readySloMs: 10_000, sloMode: "gate" },
      ),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "abort",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("warns by default for temporary recovery that never becomes pay-ready inside the SLO", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        readyLatencyMs: null,
        pageText: "Preparing checkout. Refresh checkout. Your payment has not started.",
        negativeProbe: healthyProbe,
      }),
    ).toEqual({
      finalState: "temporary",
      promotionDecision: "warn",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("warns when temporary recovery was observed even if the final account sample has no known state", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: false,
          postWriteTokenPresent: true,
          sessionCookiePresent: true,
          temporaryRecoveryVisible: false,
          temporaryRecoveryObserved: true,
          checkoutReviewVisible: false,
          readyLatencyMs: null,
          pageText: "",
          negativeProbe: healthyProbe,
        },
        { flow: "account" },
      ),
    ).toEqual({
      finalState: "temporary",
      promotionDecision: "warn",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("aborts temporary recovery on SLO breach when slo-mode is gate", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: true,
          temporaryRecoveryVisible: true,
          readyLatencyMs: null,
          pageText: "Preparing checkout. Refresh checkout. Your payment has not started.",
          negativeProbe: healthyProbe,
        },
        { sloMode: "gate" },
      ),
    ).toEqual({
      finalState: "temporary",
      promotionDecision: "abort",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("falls back to the submit-to-state latency when only checkout review visibility is provided", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        latencyMs: 1250,
      }),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    });
  });

  it("accepts compact post-write token metadata as a fresh write handoff", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: false,
        postWriteTokenPresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 700,
        negativeProbe: healthyProbe,
      }),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    });
  });

  it("records account item-page fallback evidence without weakening checkout readiness classification", () => {
    const evidence = buildGuestBuyNowProbeEvidence({
      ...baseOptions,
      flow: "account",
      observation: {
        afterWritePresent: false,
        postWriteTokenPresent: true,
        sessionCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 900,
        negativeProbe: healthyProbe,
        accountItemPageFallback: {
          stage: "load-buy-now-item-page",
          reason: "browser-navigation-timeout",
          message:
            'page.goto: Timeout 45000ms exceeded. navigating to "https://marketplace.staging.chasesets.com/items/canary?postWriteToken=compact-token"',
        },
      },
    });

    expect(evidence).toMatchObject({
      finalState: "pass",
      promotionDecision: "promote",
      accountItemPageFallback: {
        stage: "load-buy-now-item-page",
        reason: "browser-navigation-timeout",
        message: 'page.goto: Timeout 45000ms exceeded. navigating to "[redacted-url]"',
      },
    });
    expect(assertRedactedEvidence(evidence)).toEqual([]);
  });

  it("fails on the original permanent not-found symptom", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        permanentNotFoundVisible: true,
      }),
    ).toEqual({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "permanent-checkout-session-not-found",
    });
  });

  it("fails clearly when checkout start shows route-owned recovery before a session exists", () => {
    expect(
      classifyGuestBuyNowObservation({
        checkoutStartRecoveryVisible: true,
        afterWritePresent: false,
        guestCookiePresent: false,
        pageText: "Checkout needs attention. We could not start checkout from the current cart or item. View Buy Cart.",
      }),
    ).toEqual({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "checkout-start-recovery-visible",
    });
  });

  it("fails closed when fresh-write metadata or guest cookie handoff is missing", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: false,
        postWriteTokenPresent: false,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 500,
      }).failureReason,
    ).toBe("missing-after-write");
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        postWriteTokenPresent: false,
        guestCookiePresent: false,
        checkoutReviewVisible: true,
        readyLatencyMs: 500,
      }).failureReason,
    ).toBe("missing-guest-cookie");
  });

  it("requires the account session cookie for the account flow instead of the guest cookie", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: false,
          sessionCookiePresent: true,
          checkoutReviewVisible: true,
          readyLatencyMs: 700,
          negativeProbe: healthyProbe,
        },
        { flow: "account" },
      ),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    });
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: true,
          sessionCookiePresent: false,
          checkoutReviewVisible: true,
          readyLatencyMs: 700,
        },
        { flow: "account" },
      ).failureReason,
    ).toBe("missing-session-cookie");
  });

  it("fails clearly when the platform edge shows a generic error page", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        platformErrorVisible: true,
        pageText: "Error code: 503 Well, This is unexpected.",
      }),
    ).toEqual({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "platform-error-page-detected",
    });
  });

  it("aborts promotion when the negative probe shows recovery masking an invalid session", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 900,
        negativeProbe: {
          attempted: true,
          documentStatus: 200,
          permanentRecoveryVisible: false,
          temporaryRecoveryVisible: true,
          checkoutReviewVisible: false,
          platformErrorVisible: false,
        },
      }),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "abort",
      failureReason: "negative-probe-masked-invalid-session",
    });
  });

  it("aborts promotion when the negative probe lands on a platform error or unknown state", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 900,
        negativeProbe: { attempted: true, documentStatus: 503, permanentRecoveryVisible: false },
      }).failureReason,
    ).toBe("negative-probe-platform-error");
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 900,
        negativeProbe: { attempted: true, documentStatus: 200, permanentRecoveryVisible: false },
      }).failureReason,
    ).toBe("negative-probe-unexpected-state");
  });

  it("lets an unsafe probe failure override a readiness warning", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        readyLatencyMs: null,
        negativeProbe: { attempted: true, documentStatus: 200, permanentRecoveryVisible: false },
      }),
    ).toEqual({
      finalState: "temporary",
      promotionDecision: "abort",
      failureReason: "negative-probe-unexpected-state",
    });
  });

  it("keeps the headline readiness failure when gating and both readiness and the probe fail", () => {
    expect(
      classifyGuestBuyNowObservation(
        {
          afterWritePresent: true,
          guestCookiePresent: true,
          temporaryRecoveryVisible: true,
          readyLatencyMs: null,
          negativeProbe: { attempted: true, documentStatus: 200, permanentRecoveryVisible: false },
        },
        { sloMode: "gate" },
      ),
    ).toEqual({
      finalState: "temporary",
      promotionDecision: "abort",
      failureReason: "checkout-ready-slo-exceeded",
    });
  });

  it("builds redacted pass evidence without sensitive identifiers", () => {
    const evidence = buildGuestBuyNowProbeEvidence({
      ...baseOptions,
      diagnosticCorrelationId: "diag raw!/value",
      observation: {
        latencyMs: 1250,
        readyLatencyMs: 1250,
        segments: {
          writeToRedirectMs: 400,
          redirectToDocumentMs: 350,
          documentToReadyMs: 500,
          writeToCheckoutReadyMs: 1250,
        },
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        platformErrorVisible: false,
        checkoutDocumentStatus: 200,
        stateWaitOutcome: "matched",
        waitMode: "exact-dependency",
        postWriteTokenPresent: true,
        negativeProbe: healthyProbe,
        pageText:
          "Checkout Summary Continue to payment chk_01KTMF9TCCPKGA3J3TYMGGXQ2R afterWrite=raw-token postWriteToken=compact-token todd.skelton@outlook.com chase_sets_guest_checkout=secret chase_sets_session=session-secret",
      },
    });

    expect(evidence).toMatchObject({
      schemaVersion: GUEST_BUY_NOW_FRESHNESS_PROBE_VERSION,
      flow: "guest",
      finalState: "pass",
      promotionDecision: "promote",
      readySloMs: DEFAULT_READY_SLO_MS,
      readyLatencyMs: 1250,
      latencyMs: 1250,
      segments: {
        writeToRedirectMs: 400,
        redirectToDocumentMs: 350,
        documentToReadyMs: 500,
        writeToCheckoutReadyMs: 1250,
      },
      segmentReferences: SEGMENT_METRIC_REFERENCES,
      waitMode: "exact-dependency",
      afterWritePresent: true,
      postWriteTokenPresent: true,
      freshWriteMetadataPresent: true,
      platformErrorVisible: false,
      checkoutDocumentStatus: 200,
      stateWaitOutcome: "matched",
      diagnosticCorrelationId: "diag-raw--value",
      negativeProbe: { attempted: true, documentStatus: 401, outcome: "permanent-recovery" },
      paymentOrOrderSideEffects: "not-attempted",
      productionFeasibility: PRODUCTION_FEASIBILITY_DECISION,
    });
    expect(assertRedactedEvidence(evidence)).toEqual([]);
  });

  it("records a skipped negative probe explicitly", () => {
    const evidence = buildGuestBuyNowProbeEvidence({
      ...baseOptions,
      observation: {
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 800,
        negativeProbe: { attempted: false },
      },
    });

    expect(evidence.negativeProbe).toEqual({ attempted: false, outcome: "skipped" });
    expect(evidence.promotionDecision).toBe("promote");
  });

  it("parses CLI and environment defaults", () => {
    const parsed = parseGuestBuyNowProbeArgs(["--item-path", "/items/canary", "--skip-negative-probe"], {
      GUEST_BUY_NOW_PROBE_OUT: "artifacts/guest-buy-now.json",
      GUEST_BUY_NOW_PROBE_BASE_URL: "https://marketplace.staging.chasesets.com",
      GUEST_BUY_NOW_PROBE_ADMIN_BASE_URL: "https://admin.staging.chasesets.com",
      GUEST_BUY_NOW_PROBE_FIXTURE_KEY: "canary-fixture",
      GUEST_BUY_NOW_PROBE_GUEST_EMAIL: "guest-buy-now-canary@example.test",
      PLATFORM_ADMIN_EMAIL: "platform-admin@example.test",
      PLATFORM_ADMIN_PASSWORD: "platform-admin-password",
      GUEST_BUY_NOW_PROBE_ENVIRONMENT: "staging",
      GUEST_BUY_NOW_PROBE_TIMEOUT_MS: "1234",
      GUEST_BUY_NOW_PROBE_READY_SLO_MS: "9000",
      GUEST_BUY_NOW_PROBE_ATTEMPTS: "3",
      GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_BUDGET_MS: "60000",
      GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_POLL_INTERVAL_MS: "2000",
      GUEST_BUY_NOW_PROBE_CORRELATION_ID: "diag_1",
      GUEST_BUY_NOW_PROBE_SEARCH_QUERY: "pikachu",
      MARKETPLACE_E2E_EMAIL: "marketplace-e2e@example.test",
      MARKETPLACE_E2E_PASSWORD: "marketplace-e2e-password",
    });

    expect(parsed).toMatchObject({
      outPath: "artifacts/guest-buy-now.json",
      baseUrl: "https://marketplace.staging.chasesets.com",
      adminBaseUrl: "https://admin.staging.chasesets.com",
      flow: "guest",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      accountEmail: "marketplace-e2e@example.test",
      accountPassword: "marketplace-e2e-password",
      adminEmail: "platform-admin@example.test",
      adminPassword: "platform-admin-password",
      searchQuery: "pikachu",
      timeoutMs: 1234,
      readySloMs: 9000,
      maxAttempts: 3,
      wakeRuntimeReadyBudgetMs: 60000,
      wakeRuntimeReadyPollIntervalMs: 2000,
      skipNegativeProbe: true,
      diagnosticCorrelationId: "diag_1",
    });
  });

  it("uses Terraform deploy admin credentials for freshness probe synthetic account provisioning", () => {
    const parsed = parseGuestBuyNowProbeArgs(["--item-path", "/items/canary"], {
      GUEST_BUY_NOW_PROBE_BASE_URL: "https://marketplace.staging.chasesets.com",
      GUEST_BUY_NOW_PROBE_ADMIN_BASE_URL: "https://admin.staging.chasesets.com",
      GUEST_BUY_NOW_PROBE_FIXTURE_KEY: "canary-fixture",
      GUEST_BUY_NOW_PROBE_GUEST_EMAIL: "guest-buy-now-canary@example.test",
      GUEST_BUY_NOW_PROBE_SEARCH_QUERY: "pikachu",
      TF_VAR_platform_admin_email: "platform-admin@example.test",
      TF_VAR_platform_admin_password: "platform-admin-password",
    });

    expect(parsed.adminEmail).toBe("platform-admin@example.test");
    expect(parsed.adminPassword).toBe("platform-admin-password");
    expect(validateGuestBuyNowProbeOptions(parsed)).toEqual([]);
  });

  it("provisions a gated synthetic account invitation before account-flow registration", async () => {
    const invitationReceipt = commitReceiptFor([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "42",
        eventIds: ["evt_invitation"],
      },
    ]);
    const { calls, context, cookies, page } = createFakeAccountSessionPage((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        expect(call.data).toEqual({
          email: "platform-admin@example.test",
          password: "platform-admin-password",
        });
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        expect(call.data).toMatchObject({
          accountId: "acc_platform",
          email: expect.stringMatching(/^buy-now-probe\+account-/),
          roleKey: "viewer",
        });
        return new FakeResponse(
          201,
          { id: "ivt_probe", status: "pending" },
          { "chase-sets-commit-receipt": invitationReceipt },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, {
          projectionGroups: [
            {
              targetContextName: "auth",
              projectionName: "auth-identity-invitation-projection",
              subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: "42" }],
            },
          ],
        });
      }
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({
          displayName: expect.stringMatching(/^Buy Now Probe Account /),
          email: expect.stringMatching(/^buy-now-probe\+account-/),
          password: expect.stringMatching(/^buy-now-probe-/),
          registrationConsent: {
            affirmed: false,
            resolution: expect.objectContaining({ signature: "server-minted-test-signature" }),
          },
        });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await startAccountSession(
      page,
      context,
      {
        adminEmail: "platform-admin@example.test",
        adminPassword: "platform-admin-password",
      },
      "https://marketplace.test",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });

  it("requires probe configuration and rejects public production browser probes", () => {
    expect(validateGuestBuyNowProbeOptions({ flow: "guest", environment: "staging", searchQuery: "" })).toEqual([
      "GUEST_BUY_NOW_PROBE_BASE_URL or --base-url is required.",
      "GUEST_BUY_NOW_PROBE_ITEM_PATH/--item-path or GUEST_BUY_NOW_PROBE_SEARCH_QUERY/--search-query is required.",
      "GUEST_BUY_NOW_PROBE_FIXTURE_KEY or --fixture-key is required.",
      "GUEST_BUY_NOW_PROBE_GUEST_EMAIL or --guest-email is required for the guest flow.",
    ]);
    expect(
      validateGuestBuyNowProbeOptions({
        flow: "guest",
        baseUrl: "https://marketplace.staging.chasesets.com",
        adminBaseUrl: "https://admin.staging.chasesets.com",
        itemPath: "/items/canary",
        fixtureKey: "canary-fixture",
        guestEmail: "guest@example.test",
        environment: "staging",
      }),
    ).toContain(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when --admin-base-url is set for wake-runtime preflight.",
    );
    expect(
      validateGuestBuyNowProbeOptions({
        flow: "guest",
        baseUrl: "https://marketplace.chasesets.com",
        itemPath: "/items/canary",
        fixtureKey: "canary-fixture",
        guestEmail: "guest@example.test",
        environment: "production",
      }),
    ).toContain(PRODUCTION_FEASIBILITY_DECISION.reason);
  });

  it("requires the account flow, operator credentials, and a proof reference in production proof mode", () => {
    const errors = validateGuestBuyNowProbeOptions({
      flow: "guest",
      baseUrl: "https://marketplace.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "production-proof-fixture",
      guestEmail: "guest@example.test",
      environment: "production-proof",
    });

    expect(errors.join(" ")).toContain("only --flow account can run there");
    expect(errors.join(" ")).toContain("requires configured operator credentials");
    expect(errors.join(" ")).toContain("--production-proof-reference");

    expect(
      validateGuestBuyNowProbeOptions({
        flow: "account",
        baseUrl: "https://marketplace.chasesets.com",
        itemPath: "/items/canary",
        fixtureKey: "production-proof-fixture",
        accountEmail: "proof-operator@example.test",
        accountPassword: "proof-operator-password",
        productionProofReference: "proof-run-2026-06-11",
        environment: "production-proof",
      }),
    ).toEqual([]);
  });

  it("evaluates wake runtime readiness from wake-status snapshots", () => {
    expect(evaluateWakeRuntimeReadiness(readyWakeStatusSnapshot)).toEqual({
      ready: true,
      activeWakeCapableWorkerCount: 2,
      relayLeaseState: "active",
      relayOwnerId: "worker-1",
      relayLeaseRenewedAt: null,
      relayLeaseExpiresAt: null,
      relayOwnerWorkerState: null,
      relayOwnerHeartbeatAgeMs: null,
      reasons: [],
    });
    expect(evaluateWakeRuntimeReadiness(unreadyWakeStatusSnapshot)).toMatchObject({
      ready: false,
      activeWakeCapableWorkerCount: 0,
      relayLeaseState: "standby",
      reasons: ["no-active-wake-capable-workers", "projection-wake-relay-lease-not-active"],
    });
  });

  it("adds expired relay owner heartbeat evidence to wake runtime readiness", () => {
    expect(
      evaluateWakeRuntimeReadiness({
        schedulers: {
          available: true,
          activeWakeCapableWorkerCount: 1,
          workers: [{ workerId: "worker-1", workerState: "active", heartbeatAgeMs: 41_165 }],
        },
        relay: {
          available: true,
          lease: {
            state: "expired",
            ownerId: "worker-1",
            renewedAt: "2026-06-26T21:49:22.494Z",
            expiresAt: "2026-06-26T21:49:52.494Z",
          },
        },
      }),
    ).toMatchObject({
      ready: false,
      relayOwnerId: "worker-1",
      relayLeaseRenewedAt: "2026-06-26T21:49:22.494Z",
      relayLeaseExpiresAt: "2026-06-26T21:49:52.494Z",
      relayOwnerWorkerState: "active",
      relayOwnerHeartbeatAgeMs: 41_165,
      reasons: ["projection-wake-relay-lease-not-active", "projection-wake-relay-owner-not-renewing-lease"],
    });

    expect(
      evaluateWakeRuntimeReadiness({
        schedulers: {
          available: true,
          activeWakeCapableWorkerCount: 0,
          workers: [{ workerId: "worker-1", workerState: "expired", heartbeatAgeMs: 166_000 }],
        },
        relay: {
          available: true,
          lease: { state: "expired", ownerId: "worker-1" },
        },
      }),
    ).toMatchObject({
      ready: false,
      relayOwnerWorkerState: "expired",
      relayOwnerHeartbeatAgeMs: 166_000,
      reasons: [
        "no-active-wake-capable-workers",
        "projection-wake-relay-lease-not-active",
        "projection-wake-relay-owner-heartbeat-not-active",
      ],
    });
  });

  it("waits for wake runtime readiness before probing Buy Now", async () => {
    let now = 1_000;
    const sleeps = [];
    const snapshots = [unreadyWakeStatusSnapshot, readyWakeStatusSnapshot];
    const result = await waitForWakeRuntimePreflight({
      fetchWakeStatus: async () => snapshots.shift(),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      wakeRuntimeReadyBudgetMs: 5_000,
      wakeRuntimeReadyPollIntervalMs: 1_000,
    });

    expect(result).toEqual({
      attempted: true,
      ready: true,
      readyAfterMs: 1_000,
      sampleCount: 2,
      initial: evaluateWakeRuntimeReadiness(unreadyWakeStatusSnapshot),
      final: evaluateWakeRuntimeReadiness(readyWakeStatusSnapshot),
    });
    expect(sleeps).toEqual([1_000]);
  });

  it("resolves an explicit item path before searching", async () => {
    await expect(
      resolveGuestBuyNowItemPath({
        baseUrl: "https://marketplace.staging.chasesets.com",
        itemPath: "items/canary",
        searchQuery: "charizard",
      }),
    ).resolves.toBe("/items/canary");
  });

  it("matches the current Buy Now readiness and checkout session routes", () => {
    expect(
      isBuyReadinessUrl(
        "https://marketplace.staging.chasesets.com/checkout/buy/readiness?source=buy-now&listingId=lst_1",
      ),
    ).toBe(true);
    expect(isBuyReadinessUrl("https://marketplace.staging.chasesets.com/checkout/start")).toBe(false);

    expect(
      isBuySessionUrl("https://marketplace.staging.chasesets.com/checkout/buy/session/chk_123?afterWrite=redacted"),
    ).toBe(true);
    expect(isBuySessionUrl("https://marketplace.staging.chasesets.com/checkout/chk_123")).toBe(false);
  });

  it("detects legacy and compact fresh-write metadata without exposing values", () => {
    expect(
      detectFreshWriteMetadata(
        "https://marketplace.staging.chasesets.com/checkout/buy/session/chk_123?afterWrite=redacted",
      ),
    ).toEqual({
      afterWritePresent: true,
      postWriteTokenPresent: false,
      freshWriteMetadataPresent: true,
    });
    expect(
      detectFreshWriteMetadata(
        "https://marketplace.staging.chasesets.com/checkout/buy/session/chk_123?postWriteToken=redacted",
      ),
    ).toEqual({
      afterWritePresent: false,
      postWriteTokenPresent: true,
      freshWriteMetadataPresent: true,
    });
    expect(detectFreshWriteMetadata("https://marketplace.staging.chasesets.com/checkout/buy/session/chk_123")).toEqual({
      afterWritePresent: false,
      postWriteTokenPresent: false,
      freshWriteMetadataPresent: false,
    });
  });

  it("waits only for route commit before separately measuring checkout document readiness", () => {
    expect(buyNowRouteTransitionWaitOptions(12_345)).toEqual({
      waitUntil: "commit",
      timeout: 12_345,
    });
    expect(buyNowRouteTransitionWaitOptions(0)).toEqual({
      waitUntil: "commit",
      timeout: 45_000,
    });
  });

  it("waits only for item page commit before probing Buy Now controls", () => {
    expect(buyNowItemPageNavigationWaitOptions(12_345)).toEqual({
      waitUntil: "commit",
      timeout: 12_345,
    });
    expect(buyNowItemPageNavigationWaitOptions(0)).toEqual({
      waitUntil: "commit",
      timeout: 45_000,
    });
  });

  it("captures checkout document statuses for the current buy checkout session route", () => {
    expect(
      isCheckoutSessionDocumentResponseUrl(
        "https://marketplace.staging.chasesets.com/checkout/buy/session/chk_123?afterWrite=redacted",
      ),
    ).toBe(true);
    expect(isCheckoutSessionDocumentResponseUrl("https://marketplace.staging.chasesets.com/checkout/chk_123")).toBe(
      false,
    );
  });

  it("follows the shipped single-POST guest entry through a redirecting readiness hop into the checkout session", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fakeBrowser = createFakeGuestEntryBrowser([{ kind: "session" }], {
      onClick: () => {
        now = 1_040;
      },
    });

    try {
      const evidence = await runGuestBuyNowFreshnessProbe(guestEntryOptions(fakeBrowser));

      expect(evidence).toMatchObject({
        finalState: "pass",
        promotionDecision: "promote",
        failureReason: null,
        guestCookiePresent: true,
        afterWritePresent: true,
        checkoutReviewVisible: true,
        checkoutDocumentStatus: 200,
        segments: { writeToRedirectMs: 40, writeToCheckoutReadyMs: 40 },
      });
      expect(fakeBrowser.eventLog).toEqual([
        "load-item",
        "click-buy-now",
        "response-readiness-307",
        "response-session-200",
        "committed-session",
      ]);
      expect(fakeBrowser.getByLabel).not.toHaveBeenCalled();
      expect(fakeBrowser.getByRole).not.toHaveBeenCalled();
      expect(fakeBrowser.buyNowButton.click).toHaveBeenCalledTimes(1);
      expect(evidence.failureReason).not.toBe("guest-entry-stalled-at-readiness");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      title: "fails hard when guest entry commits a blank readiness document",
      pageText: "",
    },
    {
      title: "fails hard when guest entry commits a rendered readiness document",
      pageText: "Checkout is unavailable.",
    },
  ])("$title", async ({ pageText }) => {
    const fakeBrowser = createFakeGuestEntryBrowser([{ kind: "readiness", pageText }]);
    const evidence = await runGuestBuyNowFreshnessProbe(guestEntryOptions(fakeBrowser));

    expect(evidence).toMatchObject({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "guest-entry-stalled-at-readiness",
      attemptCount: 1,
      runtimeFailure: {
        stage: "wait-buy-checkout-session",
        reason: "guest-entry-stalled-at-readiness",
        message: "Guest entry committed the Checkout readiness document.",
      },
    });
    expect(
      evidence.attemptSummaries.filter(({ failureReason }) => failureReason === "guest-entry-stalled-at-readiness"),
    ).toHaveLength(1);
    expect(fakeBrowser.body.innerText).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.getByLabel).not.toHaveBeenCalled();
    expect(fakeBrowser.getByRole).not.toHaveBeenCalled();
  });

  it("keeps checkout start recovery precedence over the committed readiness stall", async () => {
    const fakeBrowser = createFakeGuestEntryBrowser([
      {
        kind: "readiness",
        pageText: "Checkout needs attention. We could not start checkout from the current cart or item.",
      },
      {
        kind: "readiness",
        pageText: "Checkout needs attention. We could not start checkout from the current cart or item.",
      },
    ]);
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/marketplace/items") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ slug: "canary", market_summary: { active_listing_count: 2, total_visible_quantity: 2 } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          market_listings: ["lst_1", "lst_2"].map((listingId) => ({
            listing_id: listingId,
            catalog_catalog_item_id: "cat_1",
            product_id: `product_${listingId}`,
            status: "active",
            price_amount: 100,
            selected_options: [],
            visible_quantity: 1,
          })),
        }),
      };
    });
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const evidence = await runGuestBuyNowFreshnessProbe(
        guestEntryOptions(fakeBrowser, { itemPath: undefined, searchQuery: "canary" }),
      );

      expect(evidence).toMatchObject({
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: "checkout-start-recovery-visible",
        checkoutStartRecoveryVisible: true,
        attemptCount: 1,
      });
      expect(evidence.attemptSummaries).toHaveLength(1);
      expect(evidence.failureReason).not.toBe("guest-entry-stalled-at-readiness");
      expect(fakeBrowser.buyNowButton.click).toHaveBeenCalledTimes(2);
      expect(fakeBrowser.body.innerText).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the guest entry readiness stall through normalization and the attempt budget", async () => {
    const fakeBrowser = createFakeGuestEntryBrowser([{ kind: "readiness", pageText: "" }]);
    const evidence = await runGuestBuyNowFreshnessProbe(
      guestEntryOptions(fakeBrowser, {
        maxAttempts: 3,
      }),
    );

    expect(fakeBrowser.launchBrowser).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "guest-entry-stalled-at-readiness",
      attemptCount: 1,
      maxAttempts: 3,
    });
    expect(evidence.attemptSummaries).toEqual([
      {
        attempt: 1,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: "guest-entry-stalled-at-readiness",
        readyLatencyMs: null,
      },
    ]);
  });

  it("discovers active buyable item candidates from marketplace search and pins the exact listing", async () => {
    const requestedUrls = [];
    const responses = [
      {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { slug: "no-market", market_summary: null },
              { slug: "empty-market", market_summary: { active_listing_count: 1, total_visible_quantity: 0 } },
              { slug: "buyable-card", market_summary: { active_listing_count: 1, total_visible_quantity: 2 } },
            ],
          };
        },
      },
      {
        ok: true,
        status: 200,
        async json() {
          return {
            market_listings: [
              {
                listing_id: "lst_1",
                catalog_catalog_item_id: "cat_buyable",
                product_id:
                  "cat_buyable::dim_seed_form:chc_seed_form_raw::dim_seed_condition:chc_seed_condition_near_mint",
                status: "active",
                price_amount: "350.00",
                visible_quantity: 2,
                catalog_catalog_item_id: "cat_1",
                product_id: "prd_1",
                item_title: "Buyable Card",
                item_subtitle: null,
                product_summary: "Form: raw | Condition: near-mint",
                selected_options: [
                  { dimensionId: "dim_seed_form", optionId: "chc_seed_form_raw" },
                  { dimensionId: "dim_seed_condition", optionId: "chc_seed_condition_near_mint" },
                ],
              },
            ],
          };
        },
      },
    ];
    const itemPath = await resolveGuestBuyNowItemPath(
      {
        baseUrl: "https://marketplace.staging.chasesets.com",
        searchQuery: "charizard",
      },
      async (url) => {
        requestedUrls.push(String(url));
        return responses.shift();
      },
    );

    expect(itemPath).toBe(
      "/items/buyable-card?market=buy&listing=lst_1&dimension.dim_seed_form=chc_seed_form_raw&dimension.dim_seed_condition=chc_seed_condition_near_mint",
    );
    expect(requestedUrls[0]).toBe(
      "https://marketplace.staging.chasesets.com/api/marketplace/items?search=charizard&includeTotal=true",
    );
    expect(requestedUrls[1]).toBe("https://marketplace.staging.chasesets.com/api/marketplace/items/buyable-card");
  });

  it("can require checkout-ready fixture candidates for authenticated account probe discovery", async () => {
    const requested = [];
    const itemSearchResponse = {
      ok: true,
      status: 200,
      async json() {
        return {
          items: [{ slug: "buyable-card", market_summary: { active_listing_count: 2, total_visible_quantity: 2 } }],
        };
      },
    };
    const itemDetailResponse = {
      ok: true,
      status: 200,
      async json() {
        return {
          market_listings: [
            {
              listing_id: "lst_stale",
              status: "active",
              visible_quantity: 1,
              catalog_catalog_item_id: "cat_1",
              product_id: "prd_stale",
              item_title: "Stale card",
              item_subtitle: null,
              product_summary: "Condition: stale",
              selected_options: [{ dimensionId: "condition", optionId: "stale" }],
            },
            {
              listing_id: "lst_ready",
              status: "active",
              visible_quantity: 1,
              catalog_catalog_item_id: "cat_1",
              product_id: "prd_ready",
              item_title: "Ready card",
              item_subtitle: null,
              product_summary: "Condition: ready",
              selected_options: [{ dimensionId: "condition", optionId: "ready" }],
            },
          ],
        };
      },
    };
    const itemPath = await resolveGuestBuyNowItemPath(
      {
        baseUrl: "https://marketplace.staging.chasesets.com",
        searchQuery: "charizard",
        requireCheckoutReady: true,
      },
      async (url, init = {}) => {
        requested.push({
          url: String(url),
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes("/api/marketplace/items?")) {
          return itemSearchResponse;
        }
        if (String(url).includes("/api/marketplace/items/buyable-card")) {
          return itemDetailResponse;
        }
        const listingId = JSON.parse(init.body).lines[0].lockedListingId;
        return {
          ok: true,
          status: 200,
          async json() {
            return { readyLineKeys: listingId === "lst_ready" ? ["lst_ready"] : [] };
          },
        };
      },
    );

    expect(itemPath).toBe("/items/buyable-card?market=buy&listing=lst_ready&dimension.condition=ready");
    expect(requested.filter((request) => request.method === "POST")).toEqual([
      expect.objectContaining({
        url: "https://marketplace.staging.chasesets.com/api/marketplace/account/purchases/checkout/preview",
        body: expect.objectContaining({
          sourceType: "buy-now",
          lines: [expect.objectContaining({ lockedListingId: "lst_stale", fulfillmentMode: "locked-listing" })],
        }),
      }),
      expect.objectContaining({
        url: "https://marketplace.staging.chasesets.com/api/marketplace/account/purchases/checkout/preview",
        body: expect.objectContaining({
          sourceType: "buy-now",
          lines: [expect.objectContaining({ lockedListingId: "lst_ready", sellerPreferenceId: "lst_ready" })],
        }),
      }),
    ]);
  });

  it("fails clearly when search cannot find a buyable item", async () => {
    await expect(
      resolveGuestBuyNowItemPath(
        {
          baseUrl: "https://marketplace.staging.chasesets.com",
          searchQuery: "missing",
        },
        async () => ({
          ok: true,
          status: 200,
          async json() {
            return { items: [{ slug: "catalog-only", market_summary: null }] };
          },
        }),
      ),
    ).rejects.toThrow("found no active buyable marketplace item");
  });

  it("fails clearly when active marketplace items have no checkout-ready candidates", async () => {
    await expect(
      resolveGuestBuyNowItemCandidates(
        {
          baseUrl: "https://marketplace.staging.chasesets.com",
          searchQuery: "blocked",
        },
        async (url, init = {}) => {
          if (String(url).includes("/api/marketplace/items?")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  items: [
                    { slug: "blocked-card", market_summary: { active_listing_count: 1, total_visible_quantity: 1 } },
                  ],
                };
              },
            };
          }
          if (String(url).includes("/api/marketplace/items/blocked-card")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  market_listings: [
                    {
                      listing_id: "lst_blocked",
                      status: "active",
                      visible_quantity: 1,
                      catalog_catalog_item_id: "cat_blocked",
                      product_id: "prd_blocked",
                      selected_options: [],
                    },
                  ],
                };
              },
            };
          }
          expect(init.method).toBe("POST");
          return {
            ok: true,
            status: 200,
            async json() {
              return { readyLineKeys: [] };
            },
          };
        },
        { requireCheckoutReady: true },
      ),
    ).rejects.toThrow("found no active buyable marketplace item");
  });

  it("writes evidence and warns for safe temporary state that never becomes pay-ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-guest-buy-now-canary-"));
    const outFile = join(directory, "guest-buy-now.json");
    const evidence = await runGuestBuyNowFreshnessProbe({
      outPath: outFile,
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      observe: async () => ({
        latencyMs: 900,
        readyLatencyMs: null,
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        pageText: "Preparing checkout Refresh checkout",
        negativeProbe: healthyProbe,
      }),
    });

    expect(evidence.finalState).toBe("temporary");
    expect(evidence.promotionDecision).toBe("warn");
    expect(evidence.failureReason).toBe("checkout-ready-slo-exceeded");
    expect(evidence.attemptCount).toBe(1);
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("records wake runtime preflight evidence before browser observation", async () => {
    let now = 1_000;
    const attempts = [];
    const snapshots = [unreadyWakeStatusSnapshot, readyWakeStatusSnapshot];
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      wakeRuntimeReadyBudgetMs: 5_000,
      wakeRuntimeReadyPollIntervalMs: 1_000,
      fetchWakeStatus: async () => snapshots.shift(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        return {
          latencyMs: 800,
          readyLatencyMs: 800,
          afterWritePresent: true,
          guestCookiePresent: true,
          checkoutReviewVisible: true,
          negativeProbe: healthyProbe,
        };
      },
    });

    expect(attempts).toEqual([1]);
    expect(evidence.promotionDecision).toBe("promote");
    expect(evidence.wakeRuntimePreflight).toEqual({
      attempted: true,
      ready: true,
      readyAfterMs: 1_000,
      sampleCount: 2,
      initial: evaluateWakeRuntimeReadiness(unreadyWakeStatusSnapshot),
      final: evaluateWakeRuntimeReadiness(readyWakeStatusSnapshot),
    });
  });

  it("fails explicitly without browser attempts when wake runtime never becomes ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-guest-buy-now-canary-"));
    const outFile = join(directory, "guest-buy-now-wake-preflight.json");
    let now = 1_000;
    let observed = false;
    const evidence = await runGuestBuyNowFreshnessProbe({
      outPath: outFile,
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      wakeRuntimeReadyBudgetMs: 500,
      wakeRuntimeReadyPollIntervalMs: 250,
      fetchWakeStatus: async () => unreadyWakeStatusSnapshot,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      observe: async () => {
        observed = true;
        return {};
      },
    });

    expect(observed).toBe(false);
    expect(evidence).toMatchObject({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "wake-runtime-not-ready-before-probe",
      runtimeFailure: {
        stage: "wake-runtime-preflight",
        reason: "wake-runtime-not-ready-before-probe",
      },
      attemptCount: 0,
      maxAttempts: 1,
      attemptSummaries: [],
      wakeRuntimePreflight: {
        attempted: true,
        ready: false,
        readyAfterMs: null,
        initial: evaluateWakeRuntimeReadiness(unreadyWakeStatusSnapshot),
        final: evaluateWakeRuntimeReadiness(unreadyWakeStatusSnapshot),
      },
    });
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("retries readiness-SLO failures up to the attempt budget and promotes on a later pass", async () => {
    const observations = [
      {
        latencyMs: 12_000,
        readyLatencyMs: null,
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        negativeProbe: healthyProbe,
      },
      {
        latencyMs: 1500,
        readyLatencyMs: 1500,
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        negativeProbe: healthyProbe,
      },
    ];
    const attempts = [];
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 3,
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        return observations.shift();
      },
    });

    expect(attempts).toEqual([1, 2]);
    expect(evidence.promotionDecision).toBe("promote");
    expect(evidence.attemptCount).toBe(2);
    expect(evidence.maxAttempts).toBe(3);
    expect(evidence.attemptSummaries).toEqual([
      {
        attempt: 1,
        finalState: "temporary",
        promotionDecision: "warn",
        failureReason: "checkout-ready-slo-exceeded",
        readyLatencyMs: null,
      },
      {
        attempt: 2,
        finalState: "pass",
        promotionDecision: "promote",
        failureReason: null,
        readyLatencyMs: 1500,
      },
    ]);
  });

  it("retries browser navigation timeouts and records redacted runtime evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-guest-buy-now-canary-"));
    const outFile = join(directory, "guest-buy-now-runtime.json");
    const attempts = [];
    const evidence = await runGuestBuyNowFreshnessProbe({
      outPath: outFile,
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 2,
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          throw new Error(
            'page.waitForURL: Timeout 45000ms exceeded. navigated to "https://marketplace.staging.chasesets.com/checkout/buy/readiness?afterWrite=raw-token&postWriteToken=compact-token&session=chk_123" guest-buy-now-canary@example.test chase_sets_guest_checkout=secret',
          );
        }

        return {
          latencyMs: 1500,
          readyLatencyMs: 1500,
          afterWritePresent: true,
          guestCookiePresent: true,
          checkoutReviewVisible: true,
          negativeProbe: healthyProbe,
        };
      },
    });

    expect(attempts).toEqual([1, 2]);
    expect(evidence.promotionDecision).toBe("promote");
    expect(evidence.attemptSummaries).toEqual([
      {
        attempt: 1,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: "browser-navigation-timeout",
        readyLatencyMs: null,
      },
      {
        attempt: 2,
        finalState: "pass",
        promotionDecision: "promote",
        failureReason: null,
        readyLatencyMs: 1500,
      },
    ]);
    expect(assertRedactedEvidence(evidence)).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("raw-token");
    expect(JSON.stringify(evidence)).not.toContain("compact-token");
    expect(JSON.stringify(evidence)).not.toContain("guest-buy-now-canary@example.test");
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("builds the signed-in Buy Now action fallback form from the resolved checkout-ready fixture", () => {
    expect(
      accountBuyNowActionFormForCandidate({
        previewRequest: {
          lines: [
            {
              listingId: "lst_1",
              lockedListingId: "lst_locked",
              productId: "prod_1",
              productSummary: "Near Mint",
              selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
              quantity: 2,
            },
          ],
        },
      }),
    ).toEqual({
      intent: "buy-this-listing",
      productId: "prod_1",
      selectedOptions: JSON.stringify([{ dimensionId: "condition", optionId: "near-mint" }]),
      productSummary: "Near Mint",
      quantity: "2",
      lockedListingId: "lst_locked",
    });
  });

  it("submits the signed-in Buy Now fallback without following the checkout redirect", async () => {
    const post = vi.fn().mockResolvedValue({
      status: () => 302,
      headers: () => ({ location: "/checkout/buy/session/chk_1?postWriteToken=compact" }),
    });
    const checkoutUrl = await submitAccountBuyNowActionFallback(
      { request: { post } },
      new URL("https://marketplace.staging.chasesets.com/items/canary?market=buy&listing=lst_1"),
      {
        previewRequest: {
          lines: [
            {
              listingId: "lst_1",
              productId: "prod_1",
              selectedOptions: [],
              quantity: 1,
            },
          ],
        },
      },
      45_000,
    );

    expect(checkoutUrl.toString()).toBe(
      "https://marketplace.staging.chasesets.com/checkout/buy/session/chk_1?postWriteToken=compact",
    );
    expect(post).toHaveBeenCalledWith(
      "https://marketplace.staging.chasesets.com/items/canary?market=buy&listing=lst_1",
      {
        form: {
          intent: "buy-this-listing",
          productId: "prod_1",
          selectedOptions: "[]",
          productSummary: "",
          quantity: "1",
          lockedListingId: "lst_1",
        },
        maxRedirects: 0,
        timeout: 45_000,
      },
    );
  });

  it("keeps fallback platform failures retryable", async () => {
    await expect(
      submitAccountBuyNowActionFallback(
        {
          request: {
            post: vi.fn().mockResolvedValue({
              status: () => 503,
              headers: () => ({}),
            }),
          },
        },
        new URL("https://marketplace.staging.chasesets.com/items/canary"),
        { previewRequest: { lines: [] } },
        45_000,
      ),
    ).rejects.toMatchObject({ reason: "platform-temporary-unavailable" });
  });

  it("records checkout start recovery as a hard fixture or availability failure", async () => {
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 3,
      observe: async () => ({
        latencyMs: 950,
        readyLatencyMs: null,
        afterWritePresent: false,
        guestCookiePresent: false,
        checkoutStartRecoveryVisible: true,
        stateWaitOutcome: "matched",
        pageText: "Checkout needs attention. We could not start checkout from the current cart or item. View Buy Cart.",
        negativeProbe: { attempted: false },
      }),
    });

    expect(evidence).toMatchObject({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "checkout-start-recovery-visible",
      checkoutStartRecoveryVisible: true,
      stateWaitOutcome: "matched",
      negativeProbe: { attempted: false, outcome: "skipped" },
      attemptCount: 1,
      maxAttempts: 3,
    });
  });

  it("retries transient platform setup failures up to the attempt budget", async () => {
    const attempts = [];
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      flow: "account",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 3,
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          const error = new Error("Buy Now probe synthetic account registration failed with HTTP 504.");
          error.stage = "start-account-session";
          error.reason = "platform-temporary-unavailable";
          throw error;
        }

        return {
          latencyMs: 1500,
          readyLatencyMs: 1500,
          afterWritePresent: true,
          sessionCookiePresent: true,
          checkoutReviewVisible: true,
          negativeProbe: healthyProbe,
        };
      },
    });

    expect(attempts).toEqual([1, 2]);
    expect(evidence.promotionDecision).toBe("promote");
    expect(evidence.attemptSummaries).toEqual([
      {
        attempt: 1,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: "platform-temporary-unavailable",
        readyLatencyMs: null,
      },
      {
        attempt: 2,
        finalState: "pass",
        promotionDecision: "promote",
        failureReason: null,
        readyLatencyMs: 1500,
      },
    ]);
  });

  it("writes runtime timeout evidence when every attempt fails before observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-guest-buy-now-canary-"));
    const outFile = join(directory, "guest-buy-now-runtime-abort.json");
    const evidence = await runGuestBuyNowFreshnessProbe({
      outPath: outFile,
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 1,
      observe: async () => {
        const error = new Error("page.goto: Timeout 45000ms exceeded.");
        error.stage = "load-buy-now-item-page";
        throw error;
      },
    });

    expect(evidence).toMatchObject({
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "browser-navigation-timeout",
      runtimeFailure: {
        stage: "load-buy-now-item-page",
        reason: "browser-navigation-timeout",
        message: "page.goto: Timeout 45000ms exceeded.",
      },
      attemptCount: 1,
      maxAttempts: 1,
    });
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("does not retry hard failures such as permanent not-found", async () => {
    const attempts = [];
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 3,
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        return {
          latencyMs: 600,
          afterWritePresent: true,
          guestCookiePresent: true,
          permanentNotFoundVisible: true,
        };
      },
    });

    expect(attempts).toEqual([1]);
    expect(evidence.failureReason).toBe("permanent-checkout-session-not-found");
    expect(evidence.promotionDecision).toBe("abort");
  });

  it("consumes remaining retries when the account setup races post-rollout projection catch-up", async () => {
    const attempts = [];
    const evidence = await runGuestBuyNowFreshnessProbe({
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      flow: "account",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      diagnosticCorrelationId: "diag_123",
      maxAttempts: 3,
      observe: async (_options, attempt) => {
        attempts.push(attempt);
        if (attempt < 3) {
          const error = new Error(
            "Buy Now probe auth invitation projection did not reach identity position 46060; last observed 46054.",
          );
          error.stage = "start-account-session";
          error.reason = SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON;
          throw error;
        }

        return {
          latencyMs: 1500,
          readyLatencyMs: 1500,
          afterWritePresent: true,
          sessionCookiePresent: true,
          checkoutReviewVisible: true,
          negativeProbe: healthyProbe,
        };
      },
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(evidence.promotionDecision).toBe("promote");
    expect(evidence.attemptSummaries.slice(0, 2)).toEqual([
      {
        attempt: 1,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON,
        readyLatencyMs: null,
      },
      {
        attempt: 2,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON,
        readyLatencyMs: null,
      },
    ]);
  });

  it("evaluates projection convergence from projection-status snapshots", () => {
    expect(evaluateProjectionConvergence(convergedProjectionStatusSnapshot)).toEqual({
      converged: true,
      available: true,
      totalGroups: 2,
      caughtUpGroups: 2,
      laggingGroups: [],
      reasons: [],
    });
    expect(evaluateProjectionConvergence(laggingProjectionStatusSnapshot)).toMatchObject({
      converged: false,
      available: true,
      totalGroups: 2,
      caughtUpGroups: 1,
      laggingGroups: ["auth-identity-invitation-projection"],
      reasons: ["projection-groups-not-caught-up"],
    });
    expect(evaluateProjectionConvergence({})).toMatchObject({
      converged: false,
      available: false,
      reasons: ["projection-status-unavailable"],
    });
  });

  it("scopes run 29666002029 auth lag and unrelated degraded groups away from the Buy Now dependency", () => {
    expect(evaluateProjectionConvergence(observedRun29666002029ProjectionStatusSnapshot)).toMatchObject({
      converged: false,
      totalGroups: 4,
      laggingGroups: [
        "auth-session-projection",
        "auth-session-transactional-email-projection",
        "collections-catalog-product-projection",
      ],
    });
    expect(
      evaluateProjectionConvergence(observedRun29666002029ProjectionStatusSnapshot, ["checkout.session-projection"]),
    ).toMatchObject({ converged: true, totalGroups: 1, laggingGroups: [] });
    expect(evaluateProjectionConvergence(laggingProjectionStatusSnapshot, ["missing-projection"])).toMatchObject({
      converged: false,
      reasons: ["required-projection-group-not-found", "no-projection-groups-found"],
    });
  });

  it("polls the projection-status surface until every group is caught up", async () => {
    let now = 1_000;
    const sleeps = [];
    const snapshots = [laggingProjectionStatusSnapshot, convergedProjectionStatusSnapshot];
    const result = await waitForProjectionConvergence({
      adminBaseUrl: "https://admin.staging.chasesets.com",
      fetchProjectionStatus: async () => snapshots.shift(),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      convergenceBudgetMs: 300_000,
      convergencePollIntervalMs: 5_000,
    });

    expect(result).toMatchObject({
      attempted: true,
      converged: true,
      convergedAfterMs: 5_000,
      sampleCount: 2,
    });
    expect(sleeps).toEqual([5_000]);
  });

  it("keeps polling through transient fetch failures during fleet restart", async () => {
    let now = 0;
    const outcomes = [
      () => {
        throw new Error("connection refused");
      },
      () => convergedProjectionStatusSnapshot,
    ];
    const result = await waitForProjectionConvergence({
      adminBaseUrl: "https://admin.staging.chasesets.com",
      fetchProjectionStatus: async () => outcomes.shift()(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      convergenceBudgetMs: 300_000,
      convergencePollIntervalMs: 5_000,
    });

    expect(result).toMatchObject({ converged: true, sampleCount: 1 });
  });

  it("proceeds without blocking when projections never converge within the budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-projection-gate-"));
    const outFile = join(directory, "staging-projection-convergence-gate.json");
    let now = 0;
    const evidence = await runProjectionConvergenceGate({
      adminBaseUrl: "https://admin.staging.chasesets.com",
      environment: "staging",
      checkedAt: baseOptions.checkedAt,
      outPath: outFile,
      fetchProjectionStatus: async () => laggingProjectionStatusSnapshot,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      convergenceBudgetMs: 15_000,
      convergencePollIntervalMs: 5_000,
    });

    expect(evidence).toMatchObject({
      promotionDecision: "proceed",
      convergenceBudgetMs: 15_000,
      convergenceProjectionNames: "all",
      gate: { attempted: true, converged: false, convergedAfterMs: null },
    });
    expect(evidence.gate.final.laggingGroups).toEqual(["auth-identity-invitation-projection"]);
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("forced non-convergence: the real CLI path warns and exits zero so probes still proceed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-projection-gate-cli-"));
    const outFile = join(directory, "staging-projection-convergence-gate.json");
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/auth/password-sign-in") {
        response.end(JSON.stringify({ sessionToken: "admin-token" }));
        return;
      }
      if (request.url === "/api/platform/projections/refresh") {
        response.end(JSON.stringify(observedRun29666002029ProjectionStatusSnapshot));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
    });

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe("object");
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          resolve("scripts/guest-buy-now-freshness-probe.mjs"),
          "--convergence-gate",
          "--environment",
          "staging",
          "--admin-base-url",
          `http://127.0.0.1:${address.port}`,
          "--convergence-budget-ms",
          "0",
          "--convergence-projection-names",
          "all",
          "--out",
          outFile,
        ],
        {
          env: {
            ...process.env,
            PLATFORM_ADMIN_EMAIL: "admin@example.test",
            PLATFORM_ADMIN_PASSWORD: "secret",
          },
        },
      );

      const evidence = JSON.parse(stdout);
      expect(evidence).toMatchObject({
        promotionDecision: "proceed",
        convergenceBudgetMs: 0,
        gate: { attempted: true, converged: false, sampleCount: 1 },
      });
      expect(stderr).toContain(
        "WARNING: staging projections did not fully converge within 0ms before the Buy Now probe",
      );
      expect(stderr).toContain("Proceeding to probes; steady-state SLO breaches still fail loudly.");
      expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
    } finally {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it("signs in as admin and reads the projection refresh surface for status", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (String(url).endsWith("/api/auth/password-sign-in")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sessionToken: "admin-token" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return convergedProjectionStatusSnapshot;
        },
      };
    });

    const snapshot = await fetchProjectionStatusSnapshot(
      {
        adminBaseUrl: "https://admin.staging.chasesets.com",
        adminEmail: "admin@example.test",
        adminPassword: "secret",
      },
      fetchImpl,
    );

    expect(snapshot).toEqual(convergedProjectionStatusSnapshot);
    expect(calls).toEqual([
      { url: "https://admin.staging.chasesets.com/api/auth/password-sign-in", method: "POST" },
      { url: "https://admin.staging.chasesets.com/api/platform/projections/refresh", method: "POST" },
    ]);
  });
});
