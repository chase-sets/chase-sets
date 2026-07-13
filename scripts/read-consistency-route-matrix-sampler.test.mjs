import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_VERSION,
  assertRouteMatrixSamplerRedacted,
  parseReadConsistencyRouteMatrixSamplerArgs,
  runReadConsistencyRouteMatrixSampler,
} from "./read-consistency-route-matrix-sampler.mjs";

const checkedAt = "2026-07-06T10:00:00.000Z";

describe("read consistency route matrix sampler", () => {
  it("parses route-matrix sampler options from flags and env", () => {
    expect(
      parseReadConsistencyRouteMatrixSamplerArgs(
        [
          "--environment",
          "staging",
          "--checked-at",
          checkedAt,
          "--checkout-probe-file",
          "artifacts/checkout.json",
          "--account-cart-probe-file",
          "artifacts/account-cart.json",
          "--deploy-window-file",
          "artifacts/deploy-window.json",
          "--out",
          "artifacts/sampler.json",
        ],
        {},
      ),
    ).toMatchObject({
      environment: "staging",
      checkedAt,
      checkoutProbePath: "artifacts/checkout.json",
      accountCartProbePath: "artifacts/account-cart.json",
      deployWindowPath: "artifacts/deploy-window.json",
      outPath: "artifacts/sampler.json",
    });

    expect(
      parseReadConsistencyRouteMatrixSamplerArgs([], {
        ROUTE_MATRIX_SAMPLER_ENVIRONMENT: "staging",
        ROUTE_MATRIX_SAMPLER_CHECKOUT_PROBE_FILE: "checkout.json",
        ROUTE_MATRIX_SAMPLER_ACCOUNT_CART_PROBE_FILE: "account-cart.json",
        ROUTE_MATRIX_SAMPLER_DEPLOY_WINDOW_FILE: "deploy-window.json",
      }),
    ).toMatchObject({
      environment: "staging",
      checkoutProbePath: "checkout.json",
      accountCartProbePath: "account-cart.json",
      deployWindowPath: "deploy-window.json",
    });
  });

  it("builds a support-safe sampler artifact with one route per route-matrix template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-matrix-sampler-"));
    const checkoutProbePath = join(dir, "checkout-probe.json");
    const accountCartProbePath = join(dir, "account-cart-probe.json");
    const outPath = join(dir, "sampler.json");
    await writeFile(
      checkoutProbePath,
      JSON.stringify({
        schemaVersion: "guest-buy-now-freshness-probe/v2",
        promotionDecision: "promote",
        finalState: "pass",
        attempts: [{ state: "pass" }],
      }),
    );
    await writeFile(
      accountCartProbePath,
      JSON.stringify({
        schemaVersion: "account-cart-consistency-probe/v1",
        promotionDecision: "promote",
        observedOutcomes: ["optimistic_applied", "reconciliation", "stale_response_discard"],
      }),
    );

    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
      checkoutProbePath,
      accountCartProbePath,
      outPath,
    });

    expect(artifact).toMatchObject({
      schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_VERSION,
      environment: "staging",
      checkedAt,
      summary: {
        routeCount: 6,
        sampledRouteCount: 2,
        blockedRouteCount: 4,
        failedRouteCount: 0,
        skippedRouteCount: 0,
        allRoutesSampled: false,
      },
      redaction: {
        supportSafe: true,
        rawUrls: "not-written",
        receipts: "not-written",
      },
    });
    expect(artifact.routes.map((route) => route.routeTemplate)).toEqual([
      "/checkout/buy/session/:sessionId",
      "/account/cart",
      "/account/sell-list",
      "/account/payouts/:payoutId",
      "/account/payments/:paymentId",
      "/account/listings/:listingId",
    ]);
    expect(artifact.routes[0]).toMatchObject({
      routeTemplate: "/checkout/buy/session/:sessionId",
      driver: "automatic",
      status: "sampled",
      outcomeCategory: "sampled",
      sourceJourney: "guest-buy-now-freshness-probe",
      attemptCount: 1,
      probeDecision: "promote",
      blockerCategory: null,
    });
    expect(artifact.routes[1]).toMatchObject({
      routeTemplate: "/account/cart",
      driver: "automatic",
      status: "sampled",
      outcomeCategory: "sampled",
      sourceJourney: "account-cart-consistency-probe",
      attemptCount: 1,
      probeDecision: "promote",
      probeFinalState: "pass",
      blockerCategory: null,
    });
    expect(artifact.routes.find((route) => route.routeTemplate === "/account/payouts/:payoutId")).toMatchObject({
      driver: "representative-commerce-state",
      status: "blocked",
      outcomeCategory: "payout-ready-private-state-required",
      blockerCategory: "private-payout-state-required",
    });
    expect(JSON.parse(await readFile(outPath, "utf8"))).toEqual(artifact);
    expect(assertRouteMatrixSamplerRedacted(artifact)).toEqual([]);
  });

  it("marks checkout as failed when the probe aborts without copying raw details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-matrix-sampler-"));
    const checkoutProbePath = join(dir, "checkout-probe.json");
    await writeFile(
      checkoutProbePath,
      JSON.stringify({
        promotionDecision: "abort",
        finalState: "temporary",
        failureReason: "hidden raw details must not be copied",
        attempts: [{ state: "temporary" }, { state: "temporary" }],
      }),
    );

    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
      checkoutProbePath,
    });

    expect(artifact.summary.failedRouteCount).toBe(1);
    expect(artifact.routes[0]).toMatchObject({
      status: "failed",
      outcomeCategory: "checkout-probe-failed",
      attemptCount: 2,
      probeDecision: "abort",
      probeFinalState: "temporary",
      blockerCategory: "checkout-probe-failed",
    });
    expect(JSON.stringify(artifact)).not.toContain("hidden raw details");
  });

  it("skips automatic samples during an active deploy window while preserving expected blockers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-matrix-sampler-deploy-window-"));
    const checkoutProbePath = join(dir, "checkout-probe.json");
    const accountCartProbePath = join(dir, "account-cart-probe.json");
    const deployWindowPath = join(dir, "deploy-window.json");
    await writeFile(
      checkoutProbePath,
      JSON.stringify({ promotionDecision: "promote", finalState: "pass", attempts: [{ state: "pass" }] }),
    );
    await writeFile(
      accountCartProbePath,
      JSON.stringify({ promotionDecision: "promote", observedOutcomes: ["reconciliation"] }),
    );
    await writeFile(
      deployWindowPath,
      JSON.stringify({
        schemaVersion: "read-consistency-route-matrix-deploy-window/v1",
        status: "active",
        source: "github-actions+argo-rollouts",
        activeRunCount: 1,
        activeRolloutCount: 1,
      }),
    );

    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
      checkoutProbePath,
      accountCartProbePath,
      deployWindowPath,
    });

    expect(artifact).toMatchObject({
      deployWindow: { status: "active", activeRunCount: 1, activeRolloutCount: 1 },
      summary: { sampledRouteCount: 0, blockedRouteCount: 4, failedRouteCount: 0, skippedRouteCount: 2 },
    });
    expect(artifact.routes[0]).toMatchObject({
      status: "skipped",
      outcomeCategory: "deploy-window-active",
      blockerCategory: "active-deploy-window",
      attemptCount: 0,
    });
    expect(artifact.routes[1].status).toBe("skipped");
    expect(artifact.routes[2].status).toBe("blocked");
  });

  it("marks account cart as failed when the cart probe aborts without copying raw details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-matrix-sampler-"));
    const accountCartProbePath = join(dir, "account-cart-probe.json");
    await writeFile(
      accountCartProbePath,
      JSON.stringify({
        promotionDecision: "abort",
        observedOutcomes: ["freshness_timeout", "reconciliation"],
        blockers: ["hidden raw account-cart details must not be copied"],
      }),
    );

    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
      accountCartProbePath,
    });

    const accountCartRoute = artifact.routes.find((route) => route.routeTemplate === "/account/cart");
    expect(artifact.summary.failedRouteCount).toBe(1);
    expect(accountCartRoute).toMatchObject({
      status: "failed",
      outcomeCategory: "account-cart-probe-failed",
      attemptCount: 1,
      probeDecision: "abort",
      probeFinalState: "freshness_timeout",
      blockerCategory: "account-cart-probe-failed",
    });
    expect(JSON.stringify(artifact)).not.toContain("hidden raw account-cart details");
  });

  it("blocks automatic routes when probe artifacts are absent", async () => {
    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
    });

    expect(artifact.summary).toMatchObject({
      sampledRouteCount: 0,
      blockedRouteCount: 6,
      failedRouteCount: 0,
    });
    expect(artifact.routes[0]).toMatchObject({
      status: "blocked",
      outcomeCategory: "checkout-probe-missing",
      blockerCategory: "checkout-probe-missing",
    });
    expect(artifact.routes[1]).toMatchObject({
      status: "blocked",
      outcomeCategory: "account-cart-probe-missing",
      blockerCategory: "redacted-account-cart-observation-required",
    });
  });

  it("rejects sensitive sampler evidence before writing", () => {
    expect(
      assertRouteMatrixSamplerRedacted({
        routeTemplate: "/account/listings/lst_secret123",
        note: "https://marketplace.staging.chasesets.com/account/listings/lst_secret123?postWriteToken=raw",
      }),
    ).toEqual(
      expect.arrayContaining([
        "https://marketplace.staging.chasesets.com/account/listings/lst_secret123?postWriteToken=raw",
        expect.stringContaining("postWriteToken=raw"),
        "lst_secret123",
      ]),
    );
  });
});
