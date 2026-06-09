import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
  PRODUCTION_FEASIBILITY_DECISION,
  assertRedactedEvidence,
  buildGuestBuyNowCanaryEvidence,
  classifyGuestBuyNowObservation,
  parseGuestBuyNowCanaryArgs,
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

describe("guest Buy Now freshness canary", () => {
  it("classifies payable checkout as pass", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
      }),
    ).toEqual({
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    });
  });

  it("classifies preparing-checkout recovery as temporary", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        pageText: "Preparing checkout. Refresh checkout. Your payment has not started.",
      }),
    ).toEqual({
      finalState: "temporary",
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

  it("fails closed when fresh receipt or guest cookie handoff is missing", () => {
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: false,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
      }).failureReason,
    ).toBe("missing-after-write");
    expect(
      classifyGuestBuyNowObservation({
        afterWritePresent: true,
        guestCookiePresent: false,
        checkoutReviewVisible: true,
      }).failureReason,
    ).toBe("missing-guest-cookie");
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

  it("builds redacted pass evidence without sensitive identifiers", () => {
    const evidence = buildGuestBuyNowCanaryEvidence({
      ...baseOptions,
      diagnosticCorrelationId: "diag raw!/value",
      observation: {
        latencyMs: 1250,
        afterWritePresent: true,
        guestCookiePresent: true,
        checkoutReviewVisible: true,
        platformErrorVisible: false,
        checkoutDocumentStatus: 200,
        stateWaitOutcome: "matched",
        waitMode: "exact-dependency",
        pageText:
          "Checkout Summary Continue to payment chk_01KTMF9TCCPKGA3J3TYMGGXQ2R afterWrite=raw-token todd.skelton@outlook.com chase_sets_guest_checkout=secret",
      },
    });

    expect(evidence).toMatchObject({
      schemaVersion: GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
      finalState: "pass",
      promotionDecision: "promote",
      latencyMs: 1250,
      waitMode: "exact-dependency",
      platformErrorVisible: false,
      checkoutDocumentStatus: 200,
      stateWaitOutcome: "matched",
      diagnosticCorrelationId: "diag-raw--value",
      paymentOrOrderSideEffects: "not-attempted",
      productionFeasibility: PRODUCTION_FEASIBILITY_DECISION,
    });
    expect(assertRedactedEvidence(evidence)).toEqual([]);
  });

  it("parses CLI and environment defaults", () => {
    const parsed = parseGuestBuyNowCanaryArgs(["--item-path", "/items/canary"], {
      GUEST_BUY_NOW_CANARY_OUT: "artifacts/guest-buy-now.json",
      GUEST_BUY_NOW_CANARY_BASE_URL: "https://marketplace.staging.chasesets.com",
      GUEST_BUY_NOW_CANARY_FIXTURE_KEY: "canary-fixture",
      GUEST_BUY_NOW_CANARY_GUEST_EMAIL: "guest-buy-now-canary@example.test",
      GUEST_BUY_NOW_CANARY_ENVIRONMENT: "staging",
      GUEST_BUY_NOW_CANARY_TIMEOUT_MS: "1234",
      GUEST_BUY_NOW_CANARY_CORRELATION_ID: "diag_1",
      GUEST_BUY_NOW_CANARY_SEARCH_QUERY: "pikachu",
    });

    expect(parsed).toMatchObject({
      outPath: "artifacts/guest-buy-now.json",
      baseUrl: "https://marketplace.staging.chasesets.com",
      itemPath: "/items/canary",
      fixtureKey: "canary-fixture",
      guestEmail: "guest-buy-now-canary@example.test",
      searchQuery: "pikachu",
      timeoutMs: 1234,
      diagnosticCorrelationId: "diag_1",
    });
  });

  it("requires canary configuration and rejects production browser canaries", () => {
    expect(validateGuestBuyNowCanaryOptions({ environment: "staging", searchQuery: "" })).toEqual([
      "GUEST_BUY_NOW_CANARY_BASE_URL or --base-url is required.",
      "GUEST_BUY_NOW_CANARY_ITEM_PATH/--item-path or GUEST_BUY_NOW_CANARY_SEARCH_QUERY/--search-query is required.",
      "GUEST_BUY_NOW_CANARY_FIXTURE_KEY or --fixture-key is required.",
      "GUEST_BUY_NOW_CANARY_GUEST_EMAIL or --guest-email is required.",
    ]);
    expect(
      validateGuestBuyNowCanaryOptions({
        baseUrl: "https://marketplace.chasesets.com",
        itemPath: "/items/canary",
        fixtureKey: "canary-fixture",
        guestEmail: "guest@example.test",
        environment: "production",
      }),
    ).toContain(PRODUCTION_FEASIBILITY_DECISION.reason);
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

  it("discovers the first active buyable item from marketplace search", async () => {
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
                status: "active",
                visible_quantity: 2,
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
      "/items/buyable-card?market=buy&dimension.dim_seed_form=chc_seed_form_raw&dimension.dim_seed_condition=chc_seed_condition_near_mint",
    );
    expect(requestedUrls[0]).toBe(
      "https://marketplace.staging.chasesets.com/api/marketplace/items?q=charizard&includeTotal=true",
    );
    expect(requestedUrls[1]).toBe("https://marketplace.staging.chasesets.com/api/marketplace/items/buyable-card");
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

  it("writes evidence and exits successfully for safe temporary state with injected observation", async () => {
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
        afterWritePresent: true,
        guestCookiePresent: true,
        temporaryRecoveryVisible: true,
        pageText: "Preparing checkout Refresh checkout",
      }),
    });

    expect(evidence.finalState).toBe("temporary");
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });
});
