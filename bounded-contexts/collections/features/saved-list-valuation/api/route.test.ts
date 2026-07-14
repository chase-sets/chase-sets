import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SavedListId } from "../../saved-lists/domain";
import { createSavedListValuationRoutes } from "./route";
import type { SavedListValuationServices } from "./runtime";

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
) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  app.route("/", createSavedListValuationRoutes(valuationServices));
  return app;
}

describe("Saved List valuation routes", () => {
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
    const response = await appWithActor(services(vi.fn().mockResolvedValue(null)), {
      accountId: "acc_other",
      permissions: ["accounts.view"],
    }).request(`/saved-lists/${listId}/valuation`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "saved_list_not_found" } });
  });
});
