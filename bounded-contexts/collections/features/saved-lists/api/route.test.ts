import { describe, expect, it, vi } from "vitest";
import { createGuestSavedListRoutes, createSavedListRoutes } from "./route";
import { Hono } from "hono";
import type { CollectionsApiEnv } from "../../../api";
import type { SavedListAnalyticsRecorder } from "./analytics-telemetry";
import { savedListAnalyticsValues, savedListAnalyticsKeys } from "./analytics-telemetry";
import { additionAnalytics } from "./analytics-telemetry";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createSavedListRuntime } from "./runtime";
import { createSavedListDiscoveryRuntime } from "./discovery-runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function additionApp(addProduct: ReturnType<typeof vi.fn>, recorder?: SavedListAnalyticsRecorder) {
  const app = new Hono<CollectionsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_synthetic", permissions: ["accounts.view"] });
    c.set("context", {
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_owner", forAccountId: "acc_synthetic" },
    } as CollectionsApiEnv["Variables"]["context"]);
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

function additionResult(replayed = false, status = "added", count = 5, created = true) {
  return {
    response: {
      command: {
        receipt: {
          outcome: "line-changes-applied",
          replayed,
          lineResults: [{ status: status === "added" ? "added" : "merged" }],
        },
        savedList: { lines: Array.from({ length: count }, () => ({ note: "synthetic_private_marker_7137" })) },
      },
      listId: "svl_synthetic",
      title: "synthetic_private_marker_7137",
      lineStatus: status,
      alreadyClaimed: false,
      analyticsLabel: "saved-list.added",
    },
    ...(created ? { createReceipt: { outcome: "created", replayed: false } } : {}),
  };
}

describe("Saved List discovery routes", () => {
  it("analytics-real-addition-receipts and analytics-real-four-to-five use genuine create/add receipts", async () => {
    const store = createInMemoryEventStore();
    const productCatalog = {
      resolveProduct: async (selection: unknown) => ({ availability: "active" as const, product: selection }),
    };
    const savedLists = createSavedListRuntime({
      eventStore: store.eventStore,
      productCatalog: productCatalog as never,
      clock: () => "2026-07-13T12:00:00.000Z",
    });
    const discovery = createSavedListDiscoveryRuntime({
      db: { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgQueryable,
      savedLists,
      productCatalog: productCatalog as never,
    });
    const events: Record<string, string>[] = [];
    const app = additionApp(discovery.addProduct as never, {
      record: (item) => {
        events.push(item);
      },
    });
    const send = (
      index: number,
      destination: "new" | "existing" = "existing",
      command = `slc_add_${index}`,
      product = index,
    ) =>
      app.request("/account/list-additions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination:
            destination === "new"
              ? {
                  kind: "new",
                  listId: "svl_real",
                  createCommandId: "slc_create",
                  title: "synthetic_private_marker_7137",
                }
              : { kind: "existing", listId: "svl_real" },
          addCommandId: command,
          lineId: `sll_${index}`,
          product: {
            catalogItemId: `cat_${product}`,
            productId: `cat_${product}::condition:near-mint`,
            selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
          },
          trackedQuantity: 7137,
          sourceSurface: "search",
        }),
      });
    const first = await send(1, "new");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(events.map((item) => item.event)).toEqual(["list_created", "product_added"]);
    expect(Object.keys(await first.json()).sort()).toEqual(
      ["alreadyClaimed", "analyticsLabel", "command", "lineStatus", "listId", "title"].sort(),
    );
    expect((await send(2)).status).toBe(200);
    expect(events.map((item) => item.event)).toEqual(["list_created", "product_added", "product_added"]);
    for (let index = 3; index <= 6; index += 1) {
      const before = events.length;
      expect((await send(index)).status).toBe(200);
      expect(events.slice(before).map((item) => item.event)).toEqual(
        index === 5 ? ["product_added", "first_five_lines"] : ["product_added"],
      );
    }
    const beforeMerge = events.length;
    expect((await send(7, "existing", "slc_merge", 6)).status).toBe(200);
    expect(events.slice(beforeMerge).map((item) => item.event)).toEqual(["product_added"]);
    const beforeReplay = events.length;
    expect((await send(5)).status).toBe(400);
    expect(events).toHaveLength(beforeReplay);
    const beforeCreateReplay = events.length;
    expect((await send(8, "new", "slc_new_add_after_create_replay")).status).toBe(200);
    expect(events.slice(beforeCreateReplay).map((item) => item.event)).toEqual(["product_added"]);
    expect(events.filter((item) => item.event === "first_five_lines")).toHaveLength(1);
    expect(events.filter((item) => item.event === "list_created")).toHaveLength(1);
    const replayedAdd = await savedLists.applyLineChanges(
      {
        commandId: "slc_add_6" as never,
        listId: "svl_real" as never,
        ownerAccountId: "acc_synthetic" as never,
        expectedVersion: 6,
        operations: [
          {
            operationId: "discovery-add",
            kind: "add",
            lineId: "sll_6" as never,
            product: {
              catalogItemId: "cat_6" as never,
              productId: "cat_6::condition:near-mint" as never,
              selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
            },
            trackedQuantity: 7137,
          },
        ],
      },
      { tenantId: "tnt_test", audit: { performedByUserId: "usr_owner", forAccountId: "acc_synthetic" } } as never,
    );
    expect(replayedAdd.receipt.replayed).toBe(true);
    expect(additionAnalytics({ command: replayedAdd, lineStatus: "added" } as never, "search")).toEqual([]);
    for (const item of events) {
      expect(Object.keys(item).sort()).toEqual(["event", ...Object.keys(savedListAnalyticsValues)].sort());
      for (const [key, values] of Object.entries(savedListAnalyticsValues)) {
        expect([...values, "none", "invalid"]).toContain(item[key]);
        if (
          !(savedListAnalyticsKeys[item.event as keyof typeof savedListAnalyticsKeys] as readonly string[]).includes(
            key,
          )
        )
          expect(item[key]).toBe("none");
      }
      expect(JSON.stringify(item)).not.toContain("7137");
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
    }
  });
  it("analytics-response-identity preserves addition response without a port and records new, existing and merged paths", async () => {
    for (const [created, status, expected] of [
      [true, "added", ["list_created", "product_added", "first_five_lines"]],
      [false, "added", ["product_added", "first_five_lines"]],
      [false, "merged", ["product_added"]],
    ] as const) {
      const result = additionResult(false, status, status === "merged" ? 4 : 5, created);
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
      expect(Object.keys(result.response).sort()).toEqual(
        ["alreadyClaimed", "analyticsLabel", "command", "lineStatus", "listId", "title"].sort(),
      );
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
  it("records nothing for a pre-mapping addition error", async () => {
    const record = vi.fn();
    const response = await additionApp(vi.fn().mockRejectedValue(new Error("unavailable")), { record }).request(
      "/account/list-additions",
      additionRequest,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(record).not.toHaveBeenCalled();
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
