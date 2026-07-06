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
          "--out",
          "artifacts/sampler.json",
        ],
        {},
      ),
    ).toMatchObject({
      environment: "staging",
      checkedAt,
      checkoutProbePath: "artifacts/checkout.json",
      outPath: "artifacts/sampler.json",
    });

    expect(
      parseReadConsistencyRouteMatrixSamplerArgs([], {
        ROUTE_MATRIX_SAMPLER_ENVIRONMENT: "staging",
        ROUTE_MATRIX_SAMPLER_CHECKOUT_PROBE_FILE: "checkout.json",
      }),
    ).toMatchObject({
      environment: "staging",
      checkoutProbePath: "checkout.json",
    });
  });

  it("builds a support-safe sampler artifact with one route per route-matrix template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-matrix-sampler-"));
    const checkoutProbePath = join(dir, "checkout-probe.json");
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

    const artifact = await runReadConsistencyRouteMatrixSampler({
      environment: "staging",
      checkedAt,
      checkoutProbePath,
      outPath,
    });

    expect(artifact).toMatchObject({
      schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_VERSION,
      environment: "staging",
      checkedAt,
      summary: {
        routeCount: 6,
        sampledRouteCount: 1,
        blockedRouteCount: 5,
        failedRouteCount: 0,
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

  it("blocks checkout when no checkout probe artifact is present", async () => {
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
