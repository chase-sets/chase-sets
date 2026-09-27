import { describe, expect, it, vi } from "vitest";
import { createGuestSavedListRoutes, createSavedListRoutes } from "./route";
import { Hono } from "hono";
import type { CollectionsApiEnv } from "../../../api";
import type { SavedListAnalyticsRecorder } from "./analytics-telemetry";

function additionApp(addProduct: ReturnType<typeof vi.fn>, recorder?: SavedListAnalyticsRecorder) {
  const app = new Hono<CollectionsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_synthetic", permissions: ["accounts.view"] });
    c.set("context", {} as CollectionsApiEnv["Variables"]["context"]);
    await next();
  });
  app.route("/", createSavedListRoutes({ addProduct } as never, recorder));
  return app;
}

const additionRequest = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    destination: {
      kind: "new",
      listId: "svl_synthetic",
      createCommandId: "slc_synthetic",
      title: "synthetic_private_marker_7137",
    },
    addCommandId: "slc_synthetic",
    lineId: "sll_synthetic",
    product: { catalogItemId: "cit_synthetic", productId: "prd_synthetic", selectedOptions: [] },
    trackedQuantity: 7137,
    sourceSurface: "search",
  }),
};

function additionResult(replayed = false, outcome = "created", status = "added", count = 5) {
  return {
    command: {
      receipt: { outcome, replayed, lineResults: [{ status: status === "added" ? "added" : "merged" }] },
      savedList: { lines: Array.from({ length: count }, () => ({ note: "synthetic_private_marker_7137" })) },
    },
    listId: "svl_synthetic",
    title: "synthetic_private_marker_7137",
    lineStatus: status,
    alreadyClaimed: false,
    analyticsLabel: "saved-list.added",
  };
}

describe("Saved List discovery routes", () => {
  it("preserves addition response without a port and records new, existing and merged paths", async () => {
    for (const [outcome, status, expected] of [
      ["created", "added", ["list_created", "product_added", "first_five_lines"]],
      ["line-changes-applied", "added", ["product_added", "first_five_lines"]],
      ["line-changes-applied", "merged", ["product_added"]],
    ] as const) {
      const result = additionResult(false, outcome, status, status === "merged" ? 4 : 5);
      const baseline = await additionApp(vi.fn().mockResolvedValue(result)).request(
        "/account/list-additions",
        additionRequest,
      );
      const record = vi.fn();
      const observed = await additionApp(vi.fn().mockResolvedValue(result), { record }).request(
        "/account/list-additions",
        additionRequest,
      );
      expect([observed.status, await observed.text(), [...observed.headers]]).toEqual([
        baseline.status,
        await baseline.text(),
        [...baseline.headers],
      ]);
      expect(record.mock.calls.map(([item]) => item.event)).toEqual(expected);
      expect(record.mock.calls.every(([item]) => item.surface === "search")).toBe(true);
    }
  });

  it("does not record an identical replayed command through the handler", async () => {
    const addProduct = vi.fn().mockResolvedValueOnce(additionResult()).mockResolvedValueOnce(additionResult(true));
    const record = vi.fn();
    const app = additionApp(addProduct, { record });
    await app.request("/account/list-additions", additionRequest);
    await app.request("/account/list-additions", additionRequest);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it.each(["throw", "reject"])("keeps status, body and headers when addition recorder %ss", async (failure) => {
    const result = additionResult();
    const baseline = await additionApp(vi.fn().mockResolvedValue(result)).request(
      "/account/list-additions",
      additionRequest,
    );
    const record =
      failure === "throw"
        ? () => {
            throw new Error("synthetic_private_marker_7137");
          }
        : () => Promise.reject(new Error("synthetic_private_marker_7137"));
    const observed = await additionApp(vi.fn().mockResolvedValue(result), { record }).request(
      "/account/list-additions",
      additionRequest,
    );
    expect([observed.status, await observed.text(), [...observed.headers]]).toEqual([
      baseline.status,
      await baseline.text(),
      [...baseline.headers],
    ]);
  });
  it("localizes signed-out access failures without revealing account or List data", async () => {
    const app = createSavedListRoutes({ listRecent: vi.fn() } as never);
    const response = await app.request("http://collections.test/account/lists/recent");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "authentication_required", message: "Sign in to manage Saved Lists." },
    });
  });

  it("requires the opaque anonymous owner for guest capture", async () => {
    const app = createGuestSavedListRoutes({ createAnonymousIntent: vi.fn() } as never);
    const response = await app.request("http://collections.test/saved-list-intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "anonymous_saved_list_required",
        message: "This Saved List addition is no longer available. Save the Product again.",
      },
    });
  });
});
