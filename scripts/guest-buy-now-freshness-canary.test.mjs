import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_READY_SLO_MS,
  GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
  PRODUCTION_FEASIBILITY_DECISION,
  SEGMENT_METRIC_REFERENCES,
  assertRedactedEvidence,
  buildGuestBuyNowCanaryEvidence,
  buyNowRouteTransitionWaitOptions,
  classifyGuestBuyNowObservation,
  isCheckoutSessionDocumentResponseUrl,
  isBuyReadinessUrl,
  isBuySessionUrl,
  parseGuestBuyNowCanaryArgs,
  resolveGuestBuyNowItemCandidates,
  resolveGuestBuyNowItemPath,
  runGuestBuyNowFreshnessCanary,
  validateGuestBuyNowCanaryOptions,
} from "./guest-buy-now-freshness-canary.mjs";

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

describe("guest Buy Now freshness canary", () => {
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

  it("fails closed when fresh receipt or guest cookie handoff is missing", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: false,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        readyLatencyMs: 500,
      }).failureReason,
    ).toBe("missing-after-write");
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
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
    const evidence = buildGuestBuyNowCanaryEvidence({
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
        negativeProbe: healthyProbe,
        pageText:
          "Checkout Summary Continue to payment chk_01KTMF9TCCPKGA3J3TYMGGXQ2R afterWrite=raw-token todd.skelton@outlook.com chase_sets_guest_checkout=secret chase_sets_session=session-secret",
      },
    });

    expect(evidence).toMatchObject({
      schemaVersion: GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
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
    const evidence = buildGuestBuyNowCanaryEvidence({
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
    const parsed = parseGuestBuyNowCanaryArgs(["--item-path", "/items/canary", "--skip-negative-probe"], {
      GUEST_BUY_NOW_CANARY_OUT: "artifacts/guest-buy-now.json",
      GUEST_BUY_NOW_CANARY_BASE_URL: "https://marketplace.staging.chasesets.com",
      GUEST_BUY_NOW_CANARY_FIXTURE_KEY: "canary-fixture",
      GUEST_BUY_NOW_CANARY_GUEST_EMAIL: "guest-buy-now-canary@example.test",
      GUEST_BUY_NOW_CANARY_ENVIRONMENT: "staging",
      GUEST_BUY_NOW_CANARY_TIMEOUT_MS: "1234",
      GUEST_BUY_NOW_CANARY_READY_SLO_MS: "9000",
      GUEST_BUY_NOW_CANARY_ATTEMPTS: "3",
      GUEST_BUY_NOW_CANARY_CORRELATION_ID: "diag_1",
      GUEST_BUY_NOW_CANARY_SEARCH_QUERY: "pikachu",
      MARKETPLACE_E2E_EMAIL: "marketplace-e2e@example.test",
      MARKETPLACE_E2E_PASSWORD: "marketplace-e2e-password",
    });

    expect(parsed).toMatchObject({
      outPath: "artifacts/guest-buy-now.json",
      baseUrl: "https://marketplace.staging.chasesets.com",
      flow: "guest",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      accountEmail: "marketplace-e2e@example.test",
      accountPassword: "marketplace-e2e-password",
      searchQuery: "pikachu",
      timeoutMs: 1234,
      readySloMs: 9000,
      maxAttempts: 3,
      skipNegativeProbe: true,
      diagnosticCorrelationId: "diag_1",
    });
  });

  it("requires canary configuration and rejects public production browser canaries", () => {
    expect(validateGuestBuyNowCanaryOptions({ flow: "guest", environment: "staging", searchQuery: "" })).toEqual([
      "GUEST_BUY_NOW_CANARY_BASE_URL or --base-url is required.",
      "GUEST_BUY_NOW_CANARY_ITEM_PATH/--item-path or GUEST_BUY_NOW_CANARY_SEARCH_QUERY/--search-query is required.",
      "GUEST_BUY_NOW_CANARY_FIXTURE_KEY or --fixture-key is required.",
      "GUEST_BUY_NOW_CANARY_GUEST_EMAIL or --guest-email is required for the guest flow.",
    ]);
    expect(
      validateGuestBuyNowCanaryOptions({
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
    const errors = validateGuestBuyNowCanaryOptions({
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
      validateGuestBuyNowCanaryOptions({
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

  it("can require checkout-ready fixture candidates for authenticated account canary discovery", async () => {
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
            'page.waitForURL: Timeout 45000ms exceeded. navigated to "https://marketplace.staging.chasesets.com/checkout/buy/readiness?afterWrite=raw-token&session=chk_123" guest-buy-now-canary@example.test chase_sets_guest_checkout=secret',
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
    expect(JSON.stringify(evidence)).not.toContain("guest-buy-now-canary@example.test");
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("records checkout start recovery as a hard fixture or availability failure", async () => {
    const evidence = await runGuestBuyNowFreshnessCanary({
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
          const error = new Error("Buy Now canary synthetic account registration failed with HTTP 504.");
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
    const evidence = await runGuestBuyNowFreshnessCanary({
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
});
