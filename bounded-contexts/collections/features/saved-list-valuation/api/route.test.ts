import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SavedListId } from "../../saved-lists/domain";
import { createSavedListValuationRoutes } from "./route";
import type { SavedListValuationServices } from "./runtime";
import type { SavedListAnalyticsRecorder } from "../../saved-lists/api/analytics-telemetry";

const listId = "svl_one" as SavedListId;

function services(getOwnerValuation = vi.fn()): SavedListValuationServices {
  return {
    getOwnerValuation,
    getViewerValuation: vi.fn(),
  };
}

function appWithActor(
  valuationServices: SavedListValuationServices,
  actor: Readonly<{ accountId: string; permissions: readonly string[] }> | null,
  recorder?: SavedListAnalyticsRecorder,
) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  app.route("/", createSavedListValuationRoutes(valuationServices, recorder));
  return app;
}

describe("Saved List valuation routes", () => {
  it("records count-only coverage with byte-identical response and detached failures", async () => {
    const actor = { accountId: "acc_synthetic", permissions: ["accounts.view"] };
    const snapshot = {
      listId: "svl_synthetic_private_marker_7137",
      summary: {
        coverage: {
          priced: { lines: 2, units: 7137 },
          total: { lines: 4, units: 7137 },
          missing: { lines: 1, units: 7137 },
          stale: { lines: 1, units: 7137 },
          lowConfidence: { lines: 0, units: 7137 },
        },
        estimatedTotalAmount: "7137.00",
      },
      lines: [],
    };
    const path = `/saved-lists/${listId}/valuation`;
    const baseline = await appWithActor(services(vi.fn().mockResolvedValue(snapshot)), actor).request(path);
    const record = vi.fn();
    for (const recorder of [
      { record },
      {
        record: () => {
          throw new Error("synthetic_private_marker_7137");
        },
      },
      { record: () => Promise.reject(new Error("synthetic_private_marker_7137")) },
    ]) {
      const observed = await appWithActor(services(vi.fn().mockResolvedValue(snapshot)), actor, recorder).request(path);
      expect([observed.status, await observed.text(), [...observed.headers]]).toEqual([
        baseline.status,
        await baseline.clone().text(),
        [...baseline.headers],
      ]);
    }
    expect(record.mock.calls.map(([item]) => item)).toEqual([
      {
        event: "valuation_coverage_band",
        surface: "none",
        outcome: "none",
        coverage_band: "partial",
        estimate_state: "incomplete",
      },
    ]);
    for (const [item] of record.mock.calls) {
      expect(Object.keys(item).sort()).toEqual(
        ["event", "surface", "outcome", "coverage_band", "estimate_state"].sort(),
      );
      expect(
        [
          "listId",
          "lineId",
          "commandId",
          "catalogItemId",
          "productId",
          "accountId",
          "verifier",
          "secret",
          "note",
          "tag",
          "trackedQuantity",
          "unitEstimateAmount",
          "estimatedValueAmount",
          "estimatedTotalAmount",
          "estimatedValueBand",
          "estimatedTotalBand",
          "lowAmount",
          "highAmount",
        ].filter((key) => Object.hasOwn(item, key)),
      ).toEqual([]);
      expect(["empty", "none", "low", "partial", "high", "full", "invalid"]).toContain(item.coverage_band);
      expect(["empty", "incomplete", "stale", "low_confidence", "current", "none", "invalid"]).toContain(
        item.estimate_state,
      );
    }
  });
  it("requires an authenticated account", async () => {
    const response = await appWithActor(services(), null).request(`/saved-lists/${listId}/valuation`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authentication_required" } });
  });

  it("loads only the current account's owner valuation", async () => {
    const getOwnerValuation = vi.fn().mockResolvedValue({
      contractVersion: 1,
      listId,
      visibility: "private",
      summary: {
        estimatedTotalAmount: null,
        estimatedTotalBand: null,
        currencyCode: "usd",
        coverage: {
          priced: { lines: 0, units: 0 },
          total: { lines: 0, units: 0 },
          missing: { lines: 0, units: 0 },
          stale: { lines: 0, units: 0 },
          lowConfidence: { lines: 0, units: 0 },
        },
        estimateAsOf: null,
        valuedAt: "2026-07-13T12:00:00.000Z",
      },
      lines: [],
    });
    const response = await appWithActor(services(getOwnerValuation), {
      accountId: "acc_owner",
      permissions: ["accounts.view"],
    }).request(`/saved-lists/${listId}/valuation`);

    expect(response.status).toBe(200);
    expect(getOwnerValuation).toHaveBeenCalledWith({
      listId,
      ownerAccountId: "acc_owner" as AccountId,
    });
  });

  it("uses a non-disclosing not-found response for another account", async () => {
    const record = vi.fn();
    const response = await appWithActor(
      services(vi.fn().mockResolvedValue(null)),
      {
        accountId: "acc_other",
        permissions: ["accounts.view"],
      },
      { record },
    ).request(`/saved-lists/${listId}/valuation`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "saved_list_not_found" } });
    expect(record).not.toHaveBeenCalled();
  });
});
