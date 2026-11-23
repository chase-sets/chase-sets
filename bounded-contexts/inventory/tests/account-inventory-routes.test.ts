import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  encodeCommitReceipt,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { action as inventoryAction, loader as inventoryLoader } from "../routes/marketplace/account-inventory";
import {
  action as inventoryImportsAction,
  loader as inventoryImportsLoader,
} from "../routes/marketplace/account-inventory-imports";
import {
  action as inventoryItemAction,
  inventoryItemActionFeedback,
  loader as inventoryItemLoader,
} from "../routes/marketplace/account-inventory-item";
import {
  action as inventoryLocationsAction,
  loader as inventoryLocationsLoader,
} from "../routes/marketplace/account-inventory-locations";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function inventoryCommit(position = "42") {
  return {
    commandReceipt: {
      mode: "eventual",
      commitPosition: position,
      commitEventIds: [`evt_inventory_${position}`],
      commitPositions: [
        {
          sourceContextName: "inventory",
          maxGlobalPosition: position,
          eventIds: [`evt_inventory_${position}`],
        },
      ],
    },
  };
}

function commitHeaders(position = "42") {
  return {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_inventory_${position}`,
    "Chase-Sets-Commit-Receipt": encodeCommitReceipt([
      {
        sourceContextName: "inventory",
        maxGlobalPosition: position,
        eventIds: [`evt_inventory_${position}`],
      },
    ]),
  };
}

describe("import recovery reads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const empty = { items: [], total: 0, count: 0 };
  const recent = { items: [{ batch_id: "imb_recent" }], total: 1, count: 1 };
  const locations = { items: [{ storage_location_id: "loc_1" }], total: 1, count: 1 };
  const detail = { batch_id: "imb_1", rows: [], can_commit: false };
  function stubReads(respond: (path: string, init?: RequestInit) => Promise<Response>) {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/auth/session") {
        return Promise.resolve(
          jsonResponse({
            actor: {
              sessionId: "ses_1",
              tenantId: "tnt_identity",
              userId: "usr_1",
              accountId: "acc_1",
              membershipId: "mbr_1",
              roleKey: "owner",
              permissions: ["inventory.view"],
            },
          }),
        );
      }
      return respond(path, init);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  function load(request = new Request("http://localhost/account/inventory/imports/imb_1"), batchId = "imb_1") {
    return inventoryImportsLoader({ request, params: batchId ? { batchId } : {}, context: undefined } as never);
  }

  it.each(["recent", "locations", "both"])("retains detail and successful data when %s reads fail", async (failed) => {
    const fetch = stubReads(async (path) => {
      if (path.endsWith("/imb_1")) return jsonResponse(detail);
      if (
        (path.endsWith("/import-batches") && failed !== "locations") ||
        (path.endsWith("/storage-locations") && failed !== "recent")
      )
        return jsonResponse({}, 503);
      return jsonResponse(path.endsWith("/import-batches") ? recent : locations);
    });
    const result = await load();
    expect(result.detail).toEqual(detail);
    expect(result.batches.items).toEqual(failed === "locations" ? recent.items : []);
    expect(result.storageLocations.items).toEqual(failed === "recent" ? locations.items : []);
    expect(result.batchesLoadMessage).toEqual(failed === "locations" ? null : expect.stringContaining("unavailable"));
    expect(result.storageLocationsLoadMessage).toEqual(
      failed === "recent" ? null : expect.stringContaining("unavailable"),
    );
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it.each([408, 429, 500, 502, 504, "transport"])("classifies %s as unavailable, not empty", async (status) => {
    stubReads(async (path) => {
      if (path.endsWith("/imb_1")) return jsonResponse(detail);
      if (status === "transport") throw new TypeError("Network unavailable");
      return jsonResponse({}, status as number);
    });
    const result = await load();
    expect(result.detail).toEqual(detail);
    expect(result.batchesLoadMessage).toContain("unavailable");
    expect(result.storageLocationsLoadMessage).toContain("unavailable");
  });

  it.each([401, 403, 400, 404, 422])("preserves permanent/auth refusal %s", async (status) => {
    stubReads(async (path) =>
      jsonResponse(path.endsWith("/imb_1") ? detail : {}, path.endsWith("/imb_1") ? 200 : status),
    );
    await expect(load()).rejects.toMatchObject({ status });
  });

  it("distinguishes successfully empty data", async () => {
    stubReads(async () => jsonResponse(empty));
    const result = await load(new Request("http://localhost/account/inventory/imports"), "");
    expect(result).toMatchObject({
      batches: empty,
      storageLocations: empty,
      batchesLoadMessage: null,
      storageLocationsLoadMessage: null,
    });
  });

  it("retains pending resource recovery even when both secondary reads fail", async () => {
    stubReads(async (path) =>
      path.endsWith("/imb_1")
        ? jsonResponse({ error: { code: "projection_freshness_timeout", message: "Catching up" } }, 503)
        : jsonResponse({}, 503),
    );
    const result = await load(
      new Request(`http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_1", inventoryCommit())}`),
    );
    expect(result.detail).toBeNull();
    expect(result.detailLoadMessage).toContain("still updating");
    expect(result.batchesLoadMessage).toContain("unavailable");
    expect(result.storageLocationsLoadMessage).toContain("unavailable");
  });

  it.each([403, 404])("preserves detail resource refusal %s despite unavailable secondary reads", async (status) => {
    stubReads(async (path) => jsonResponse({}, path.endsWith("/imb_1") ? status : 503));
    await expect(load()).rejects.toMatchObject({ status });
  });

  it("bounds both never-settling secondary fetches to ten seconds and cancels their signals", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    stubReads(async (path, init) => {
      if (path.endsWith("/imb_1")) return jsonResponse(detail);
      signals.push(init!.signal!);
      return new Promise<Response>(() => undefined);
    });
    const pending = load();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.detail).toEqual(detail);
    expect(result.batchesLoadMessage).toContain("unavailable");
    expect(result.storageLocationsLoadMessage).toContain("unavailable");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 401, 403, 422])("bounds a stalled %s secondary body by the original read deadline", async (status) => {
    vi.useFakeTimers();
    const bodyPulled = vi.fn();
    const bodyAborted = vi.fn();
    stubReads(async (path, init) => {
      if (path.endsWith("/imb_1")) return jsonResponse(detail);
      if (path.endsWith("/storage-locations")) return jsonResponse(locations);
      const signal = init!.signal!;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            signal.addEventListener(
              "abort",
              () => {
                bodyAborted();
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
          pull: bodyPulled,
        }),
        { status },
      );
    });
    const pending = load().then(
      (data) => ({ data }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(bodyPulled).toHaveBeenCalled();
    expect(bodyAborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bodyAborted).toHaveBeenCalledOnce();
    if (status === 200) {
      expect(await pending).toMatchObject({
        data: {
          detail,
          batches: empty,
          storageLocations: locations,
          batchesLoadMessage: expect.stringContaining("unavailable"),
          storageLocationsLoadMessage: null,
        },
      });
    } else {
      expect(await pending).toMatchObject({ error: { status } });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains pending detail and recent imports when a secondary body fails after headers", async () => {
    vi.useFakeTimers();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const bodyPulled = vi.fn();
    stubReads(async (path) => {
      if (path.endsWith("/imb_1")) {
        return jsonResponse({ error: { code: "projection_freshness_timeout", message: "Catching up" } }, 503);
      }
      if (path.endsWith("/import-batches")) return jsonResponse(recent);
      return new Response(
        new ReadableStream({
          start(controller) {
            body = controller;
            controller.enqueue(new TextEncoder().encode("{"));
          },
          pull: bodyPulled,
        }),
      );
    });
    const pending = load(
      new Request(`http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_1", inventoryCommit())}`),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(bodyPulled).toHaveBeenCalled();
    body.error(new TypeError("Body transport interrupted"));
    await expect(pending).resolves.toMatchObject({
      detail: null,
      detailLoadMessage: expect.stringContaining("still updating"),
      batches: recent,
      batchesLoadMessage: null,
      storageLocations: empty,
      storageLocationsLoadMessage: expect.stringContaining("unavailable"),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "cancels the actual detail and secondary fetches (detail pending: %s)",
    async (pendingDetail) => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const cleaned = vi.fn();
      stubReads(async (path, init) => {
        if (!pendingDetail && path.endsWith("/imb_1")) return jsonResponse(detail);
        const signal = init?.signal;
        if (!signal) throw new Error("Fetch lost cancellation");
        signals.push(signal);
        return new Promise<Response>((_, reject) => {
          const abort = () => {
            signal.removeEventListener("abort", abort);
            cleaned();
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      });
      const controller = new AbortController();
      const pending = load(
        new Request(`http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_1", inventoryCommit())}`, {
          signal: controller.signal,
        }),
      );
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(pendingDetail ? 3 : 2);
      controller.abort();
      await rejected;
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(cleaned).toHaveBeenCalledTimes(signals.length);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("marketplace inventory routes", () => {
  it.each(["imr_api_next", null])("resolve-row redirects from next_needs_seller_row_id: %s", async (nextRowId) => {
    const resolveCalls: Array<{ url: string; body: unknown; attempt: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/rows/"))
          resolveCalls.push({
            url: String(input),
            body: JSON.parse(String(init?.body)),
            attempt: new Headers(init?.headers).get("Inventory-Mutation-Attempt"),
          });
        if (String(input).includes("/api/auth/session"))
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        return Promise.resolve(
          jsonResponse({
            next_needs_seller_row_id: nextRowId,
            rows: [
              {
                row_id: "imr_local_wrong",
                status: "rejected",
                resolution_status: "unresolved",
                product_id: null,
                committed_at: null,
                needs_seller: true,
              },
            ],
          }),
        );
      }),
    );
    const body = new URLSearchParams({
      intent: "resolve-row",
      batchId: "imb_1",
      rowId: "imr_fixed",
      catalogItemId: "cat_1",
      storageLocationId: "loc_1",
      selectedOptions: "[]",
      expectedRowVersion: "2026-11-01T08:00:00.123456Z",
      expectedRowFingerprint: "native-csv|1",
      inventoryMutationAttemptId: "7d3d2c8f-963e-4e4b-b6d9-9c5092403b07",
    });
    const result = await inventoryImportsAction({
      request: new Request("http://localhost/account/inventory/imports/imb_1", {
        method: "POST",
        body,
      }),
      params: { batchId: "imb_1" },
      context: undefined,
    } as never);
    expect((result as Response).headers.get("Location")).toBe(
      nextRowId ? "/account/inventory/imports/imb_1?resolveRowId=imr_api_next" : "/account/inventory/imports/imb_1",
    );
    // issue-7169-ac7: the rendered row facts and the form's persisted attempt reach the resolve authority verbatim.
    expect(resolveCalls).toEqual([
      {
        url: expect.stringMatching(/\/import-batches\/imb_1\/rows\/imr_fixed\/resolve$/),
        body: {
          catalogItemId: "cat_1",
          selectedOptions: [],
          storageLocationId: "loc_1",
          expectedRowVersion: "2026-11-01T08:00:00.123456Z",
          expectedRowFingerprint: "native-csv|1",
        },
        attempt: "7d3d2c8f-963e-4e4b-b6d9-9c5092403b07",
      },
    ]);
  });
  it("loads inventory items and locations through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await inventoryLoader({
      request: new Request("http://localhost/account/inventory"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items.items).toEqual([]);
    expect(result.locations.items).toEqual([]);
  });

  it("keeps the account inventory route loadable when item reads fail temporarily", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "query_wait_timeout",
                message: "Inventory list query waited too long for a database connection.",
              },
            },
            500,
          ),
        );
      }),
    );

    const result = await inventoryLoader({
      request: new Request("http://localhost/account/inventory"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items.items).toEqual([]);
    expect(result.locations.items).toEqual([]);
    expect(result.loadError).toBe("Inventory items are taking longer than expected. Reload this page in a moment.");
  });

  it("bounds the account inventory item read before the route load budget is exhausted", async () => {
    vi.useFakeTimers();
    const itemReadSignals: AbortSignal[] = [];

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);

          if (url.includes("/api/auth/session")) {
            return Promise.resolve(
              jsonResponse({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["inventory.view", "inventory.manage"],
                },
              }),
            );
          }

          if (url.includes("/api/inventory/storage-locations")) {
            return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
          }

          if (init?.signal) {
            itemReadSignals.push(init.signal);
          }
          return new Promise<Response>(() => undefined);
        }),
      );

      const resultPromise = inventoryLoader({
        request: new Request("http://localhost/account/inventory"),
        params: {},
        context: undefined,
      } as never);

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.items.items).toEqual([]);
      expect(result.locations.items).toEqual([]);
      expect(result.loadError).toBe("Inventory items are taking longer than expected. Reload this page in a moment.");
      expect(itemReadSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads Sell List inventory create draft from safe query parameters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const selectedOptions = encodeURIComponent(JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]));
    const result = await inventoryLoader({
      request: new Request(
        `http://localhost/account/inventory?catalogItemId=cat_1&selectedOptions=${selectedOptions}&returnTo=%2Faccount%2Fsell-list`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.createItemDraft).toEqual({
      catalogItemId: "cat_1",
      selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      returnTo: "/account/sell-list",
    });
  });

  it("returns action errors from the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ error: "Bad inventory input." }, 400));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-item");
    form.set("catalogItemId", "cat_1");
    form.set("selectedOptions", "[]");
    form.set("storageLocationId", "loc_1");
    form.set("totalQuantity", "3");

    const result = await inventoryAction({
      request: new Request("http://localhost/account/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ error: "Bad inventory input.", intent: "create-item" });
  });

  describe("forwards cert and refuses stale card", () => {
    const staleCard = JSON.stringify({
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: "cert-123",
      population: null,
      conditionDescriptors: [],
    });
    const graded = JSON.stringify([
      { dimensionId: "dim_form", optionId: "opt_graded" },
      { dimensionId: "dim_company", optionId: "opt_psa" },
      { dimensionId: "dim_grade", optionId: "opt_ten" },
    ]);
    const raw = JSON.stringify([{ dimensionId: "dim_form", optionId: "opt_raw" }]);

    function stubInventoryApi(createRequests: unknown[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);

          if (url.includes("/api/auth/session")) {
            return Promise.resolve(
              jsonResponse({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["inventory.view", "inventory.manage"],
                },
              }),
            );
          }

          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          createRequests.push(body);
          return Promise.resolve(
            "gradedCard" in body
              ? jsonResponse(
                  { error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." } },
                  400,
                )
              : jsonResponse({ id: "inv_created", version: 7 }, 201, commitHeaders("61")),
          );
        }),
      );
    }

    function submit(fields: Record<string, string>) {
      const form = new URLSearchParams({
        intent: "create-item",
        catalogItemId: "cat_1",
        storageLocationId: "loc_1",
        totalQuantity: "3",
        ...fields,
      });
      return inventoryAction({
        request: new Request("http://localhost/account/inventory", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: {},
        context: undefined,
      } as never);
    }

    const base = { catalogItemId: "cat_1", storageLocationId: "loc_1", totalQuantity: 3 };
    const noCost = { acquisitionCostAmount: null, acquisitionCostCurrencyCode: null };

    it.each([
      [
        "new cert form",
        { selectedOptions: graded, certificationNumber: " cert-123 " },
        { certificationNumber: "cert-123" },
      ],
      ["new blank cert form", { selectedOptions: graded, certificationNumber: "   " }, { certificationNumber: null }],
      ["new raw form", { selectedOptions: raw }, {}],
      ["new raw-after-cert form", { selectedOptions: raw }, {}],
      ["new no-metadata form", { selectedOptions: graded }, {}],
      ["old raw form", { selectedOptions: raw }, {}],
      ["empty stale card field", { selectedOptions: raw, gradedCard: "" }, {}],
    ])("sends the %s exactly and carries the receipt into the detail redirect", async (_name, fields, forwarded) => {
      const createRequests: unknown[] = [];
      stubInventoryApi(createRequests);

      const response = (await submit(fields)) as Response;

      const location = response.headers.get("Location") ?? "";
      expect(location).toContain("/account/inventory/items/inv_created?");
      expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("61");
      expect(createRequests).toEqual([{ ...base, selectedOptions: fields.selectedOptions, ...forwarded, ...noCost }]);
    });

    it("forwards an old graded form's card unread and shows Inventory's refusal", async () => {
      const createRequests: unknown[] = [];
      stubInventoryApi(createRequests);

      const result = await submit({ selectedOptions: graded, gradedCard: staleCard });

      expect(createRequests).toEqual([{ ...base, selectedOptions: graded, gradedCard: staleCard, ...noCost }]);
      expect(result).toEqual({ error: "Inventory request was not accepted.", intent: "create-item" });
    });
  });
  it("returns to Sell List after creating inventory from a Sell List recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "inv_created", version: 7 }, 201, commitHeaders("62")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-item");
    form.set("catalogItemId", "cat_1");
    form.set("selectedOptions", "[]");
    form.set("storageLocationId", "loc_1");
    form.set("totalQuantity", "3");
    form.set("returnTo", "/account/sell-list");

    const response = (await inventoryAction({
      request: new Request("http://localhost/account/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/sell-list?");
    expect(location).not.toContain("feedbackWorkflow=");
    expect(location).not.toContain("feedbackEntityId=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("62");
  });

  it("loads inventory item detail through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            item_id: "inv_1",
            account_id: "acc_1",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::dim_condition:near_mint|dim_form:raw",
            item_title: "Charizard ex",
            item_subtitle: null,
            selected_options: [
              { dimensionId: "dim_condition", optionId: "near_mint" },
              { dimensionId: "dim_form", optionId: "raw" },
            ],
            product_summary: "Condition: Near Mint | Form: Raw",
            storage_location_id: "loc_1",
            storage_location_name: "North shelf",
            ship_from_code: "CHI-WH-1",
            total_quantity: 8,
            held_quantity: 1,
            available_quantity: 7,
            acquisition_cost_amount: "4.25",
            acquisition_cost_currency_code: "USD",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            holds: [],
          }),
        );
      }),
    );

    const result = await inventoryItemLoader({
      request: new Request("http://localhost/account/inventory/items/inv_1"),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    expect(result.item.available_quantity).toBe(7);
  });

  it("forwards fresh-write receipts to inventory item detail reads", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            item_id: "inv_1",
            account_id: "acc_1",
            catalog_catalog_item_id: "cat_1",
            product_id: "cat_1::condition:near_mint",
            item_title: "Charizard ex",
            item_subtitle: null,
            selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
            product_summary: "Condition: Near Mint",
            storage_location_id: "loc_1",
            storage_location_name: "North shelf",
            ship_from_code: "CHI-WH-1",
            total_quantity: 8,
            held_quantity: 1,
            available_quantity: 7,
            acquisition_cost_amount: "4.25",
            acquisition_cost_currency_code: "USD",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            holds: [],
          }),
        );
      }),
    );

    await inventoryItemLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/items/inv_1", inventoryCommit("71"))}`,
      ),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    const detailRead = requests.find((request) => request.url.includes("/api/inventory/items/inv_1"));
    expect(detailRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
  });

  it("returns bounded recovery while fresh inventory item detail is catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Inventory projection is catching up.",
              },
            },
            503,
          ),
        );
      }),
    );

    await expect(
      inventoryItemLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/inventory/items/inv_1", inventoryCommit("62"))}`,
        ),
        params: { itemId: "inv_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("treats expired fresh-write inventory item not-found responses as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "not_found",
                message: "Inventory item not found.",
              },
            },
            404,
          ),
        );
      }),
    );

    const expiredReceipt = encodeFreshWriteReceipt({
      observedAtMs: 1,
      commitPosition: "72",
      sources: [
        {
          sourceContextName: "inventory",
          maxGlobalPosition: "72",
          eventIds: ["evt_inventory_72"],
        },
      ],
    });

    await expect(
      inventoryItemLoader({
        request: new Request(`http://localhost/account/inventory/items/inv_missing?afterWrite=${expiredReceipt}`),
        params: { itemId: "inv_missing" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("carries inventory item adjustment receipts into the detail redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "inv_1", version: 8, status: "adjusted" }, 200, commitHeaders("73")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "adjust-item");
    form.set("quantityDelta", "2");
    form.set("reason", "Cycle count");
    form.set("reasonCode", "correction");
    form.set("note", "Counted twice");

    const response = (await inventoryItemAction({
      request: new Request("http://localhost/account/inventory/items/inv_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/inventory/items/inv_1?afterWrite=");
    expect(location).not.toContain("feedbackWorkflow=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("73");
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('"reasonCode":"correction"');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('"note":"Counted twice"');
  });

  it("loads import batch workbench data through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_1")) {
          return Promise.resolve(
            jsonResponse({
              batch_id: "imb_1",
              account_id: "acc_1",
              status: "uploaded",
              source_filename: "stock.csv",
              total_count: 1,
              accepted_count: 1,
              rejected_count: 0,
              committed_count: 0,
              created_at: "2026-05-09T00:00:00.000Z",
              updated_at: "2026-05-09T00:00:00.000Z",
              rows: [],
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                batch_id: "imb_1",
                account_id: "acc_1",
                status: "uploaded",
                source_filename: "stock.csv",
                total_count: 1,
                accepted_count: 1,
                rejected_count: 0,
                committed_count: 0,
                created_at: "2026-05-09T00:00:00.000Z",
                updated_at: "2026-05-09T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request("http://localhost/account/inventory/imports/imb_1"),
      params: { batchId: "imb_1" },
      context: undefined,
    } as never);

    expect(result.batches.items).toHaveLength(1);
    expect(result.detail?.batch_id).toBe("imb_1");
  });

  it("renders a freshly committed mixed import batch without forwarding freshness to secondary reads", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_mixed")) {
          return Promise.resolve(
            jsonResponse({
              batch_id: "imb_mixed",
              account_id: "acc_1",
              status: "committed",
              source_key: "native-csv",
              adapter_version: 1,
              quantity_mode: "add",
              default_storage_location_id: "loc_1",
              source_filename: "mixed.csv",
              total_count: 2,
              accepted_count: 1,
              rejected_count: 1,
              committed_count: 1,
              created_at: "2026-05-09T00:00:00.000Z",
              updated_at: "2026-05-09T00:00:00.000Z",
              rows: [
                {
                  row_id: "imr_accepted",
                  batch_id: "imb_mixed",
                  row_number: 2,
                  status: "committed",
                  raw_row: {},
                  external_reference: null,
                  row_fingerprint: "native-csv|2|cat_1",
                  quantity_mode: "add",
                  quantity_delta: 2,
                  set_quantity: null,
                  source_price_amount: null,
                  resolution_status: "native",
                  catalog_item_id: "cat_1",
                  product_id: "cat_1::condition:near_mint",
                  selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
                  storage_location_id: "loc_1",
                  total_quantity: 2,
                  acquisition_cost_amount: null,
                  acquisition_cost_currency_code: null,
                  seller_sku: null,
                  listing_price_amount: "4.44",
                  listing_quantity_cap: 1,
                  row_note: null,
                  validation_errors: [],
                  committed_inventory_item_id: "inv_committed",
                  committed_listing_id: null,
                  committed_at: "2026-05-09T00:00:01.000Z",
                  created_at: "2026-05-09T00:00:00.000Z",
                  updated_at: "2026-05-09T00:00:01.000Z",
                },
                {
                  row_id: "imr_rejected",
                  batch_id: "imb_mixed",
                  row_number: 3,
                  status: "rejected",
                  raw_row: {},
                  external_reference: null,
                  row_fingerprint: "native-csv|3|cat_missing",
                  quantity_mode: "add",
                  quantity_delta: null,
                  set_quantity: null,
                  source_price_amount: null,
                  resolution_status: "unresolved",
                  catalog_item_id: "cat_missing",
                  product_id: null,
                  selected_options: [],
                  storage_location_id: "loc_1",
                  total_quantity: 2,
                  acquisition_cost_amount: null,
                  acquisition_cost_currency_code: null,
                  seller_sku: null,
                  listing_price_amount: null,
                  listing_quantity_cap: null,
                  row_note: "rejected",
                  validation_errors: ["Catalog item was not found."],
                  committed_inventory_item_id: null,
                  committed_listing_id: null,
                  committed_at: null,
                  created_at: "2026-05-09T00:00:00.000Z",
                  updated_at: "2026-05-09T00:00:00.000Z",
                },
              ],
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(
          jsonResponse({
            items: [],
            total: 0,
            count: 0,
          }),
        );
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_mixed", inventoryCommit("409"))}`,
      ),
      params: { batchId: "imb_mixed" },
      context: undefined,
    } as never);

    expect(result.detail).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      accepted_count: 1,
      rejected_count: 1,
      committed_count: 1,
    });
    expect(result.detail?.rows).toEqual([
      expect.objectContaining({
        status: "committed",
        committed_inventory_item_id: "inv_committed",
      }),
      expect.objectContaining({
        status: "rejected",
        validation_errors: ["Catalog item was not found."],
      }),
    ]);

    const detailRead = requests.find((request) => request.url.includes("/api/inventory/import-batches/imb_mixed"));
    const importListRead = requests.find(
      (request) => request.url.includes("/api/inventory/import-batches") && !request.url.includes("imb_mixed"),
    );
    const storageLocationRead = requests.find((request) => request.url.includes("/api/inventory/storage-locations"));

    expect(detailRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(importListRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
    expect(storageLocationRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

  it("returns route-owned import recovery while fresh committed batch detail is catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_pending")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Inventory import projection is catching up.",
                },
              },
              503,
            ),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_pending", inventoryCommit("410"))}`,
      ),
      params: { batchId: "imb_pending" },
      context: undefined,
    } as never);

    expect(result.detail).toBeNull();
    expect(result.detailLoadMessage).toBe("The import batch is still updating. Reload this page in a moment.");
    expect(result.batches.items).toEqual([]);
    expect(result.storageLocations.items).toEqual([]);
  });

  it("creates and commits import batches through route actions", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              jobId: url.includes("/commit") ? "job_commit" : "job_create",
              status: "queued",
              payload: { accountId: "acc_1", batchId: url.includes("/commit") ? "imb_1" : undefined },
              progress: { phase: "queued", completed: 0, total: 1, currentRowId: null, message: null },
              result: null,
              errorMessage: null,
              createdAt: "2026-05-09T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              updatedAt: "2026-05-09T00:00:00.000Z",
            },
            202,
          ),
        );
      }),
    );

    const createForm = new URLSearchParams();
    createForm.set("intent", "create-batch");
    createForm.set("csvText", "catalogItemId,storageLocationId,totalQuantity\ncat_1,loc_1,1");
    createForm.set("sourceFilename", "stock.csv");
    const createResponse = await inventoryImportsAction({
      request: new Request("http://localhost/account/inventory/imports", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: createForm.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    const commitForm = new URLSearchParams();
    commitForm.set("intent", "commit-batch");
    commitForm.set("batchId", "imb_1");
    const commitResponse = await inventoryImportsAction({
      request: new Request("http://localhost/account/inventory/imports/imb_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: commitForm.toString(),
      }),
      params: { batchId: "imb_1" },
      context: undefined,
    } as never);

    expect(createResponse).toBeInstanceOf(Response);
    expect((createResponse as Response).headers.get("Location")).toBe("/account/inventory/imports?jobId=job_create");
    expect(commitResponse).toBeInstanceOf(Response);
    expect((commitResponse as Response).headers.get("Location")).toBe(
      "/account/inventory/imports/imb_1?jobId=job_commit",
    );
    expect(requestedUrls.some((url) => url.includes("/api/inventory/import-batches/imb_1/commit"))).toBe(true);
  });

  it.each([
    { intent: "create-location", method: "POST", suffix: "", archived: undefined },
    { intent: "update-location", method: "PATCH", suffix: "/loc_1", archived: false },
    { intent: "archive-location", method: "PATCH", suffix: "/loc_1", archived: true },
  ])("carries $intent through the Inventory API into the list redirect", async ({ intent, method, suffix, archived }) => {
    const fetch = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "loc_1", version: 3 }, method === "POST" ? 201 : 200, commitHeaders("63")));
    });
    vi.stubGlobal("fetch", fetch);

    const attemptId = "e6bbd002-97fb-4502-9c9a-11f84f201ff0";
    const form = new URLSearchParams();
    form.set("intent", intent);
    form.set("storageLocationId", "loc_1");
    form.set("inventoryMutationAttemptId", attemptId);
    form.set("name", "North shelf");
    form.set("description", "  Seller stock  ");
    form.set("shipFromCode", "CHI-WH-1");
    form.set("shipFromName", "Inventory");
    form.set("shipFromLine1", "100 Test Lane");
    form.set("shipFromCity", "Chicago");
    form.set("shipFromState", "IL");
    form.set("shipFromPostalCode", "60601");
    form.set("shipFromCountry", "US");

    const response = (await inventoryLocationsAction({
      request: new Request("http://localhost/account/inventory/locations", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "fixture=session" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/inventory/locations?afterWrite=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("63");
    const [, init] = fetch.mock.calls.find(([input]) =>
      new URL(String(input)).pathname === `/api/inventory/storage-locations${suffix}`,
    )!;
    expect(init?.method).toBe(method);
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("Cookie")).toBe("fixture=session");
    expect(headers.get("Inventory-Mutation-Attempt")).toBe(attemptId);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "North shelf",
      description: "Seller stock",
      shipFromCode: "CHI-WH-1",
      shipFromAddress: {
        name: "Inventory",
        company: null,
        line1: "100 Test Lane",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: null,
        email: null,
      },
      ...(archived === undefined ? {} : { isArchived: archived }),
    });
  });

  it("returns bounded recovery while fresh storage locations are catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Inventory storage locations are catching up.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await inventoryLocationsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/locations", inventoryCommit("64"))}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.locations.items).toEqual([]);
    expect(result.loadError).toBe("Storage locations are still updating. Reload this page in a moment.");
  });

  it.each([
    [
      "adjust-item",
      {
        intent: "adjust-item",
        quantityDelta: "-1",
        reasonCode: "correction",
        reason: "Count correction",
      },
    ],
    [
      "record-offline-sale",
      {
        intent: "record-offline-sale",
        itemId: "inv_1",
        quantity: "1",
        channel: "card-show",
        collisionMode: "protect-orders",
        idempotencyKey: "sale-error",
      },
    ],
    ["create-hold", { intent: "create-hold", quantity: "5", reason: "Checkout" }],
    ["release-hold", { intent: "release-hold", holdId: "hld_1" }],
  ] as const)("preserves %s ownership on inventory item action validation errors", async (intent, fields) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ error: `${intent} failed.` }, 400));
      }),
    );

    const form = new URLSearchParams(fields);

    const result = await inventoryItemAction({
      request: new Request("http://localhost/account/inventory/items/inv_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({ error: `${intent} failed.`, intent });
  });

  it.each(["adjust-item", "record-offline-sale", "create-hold", "release-hold"] as const)(
    "assigns the %s error to exactly one detail-page owner",
    (intent) => {
      const feedback = inventoryItemActionFeedback({ error: `${intent} failed.`, intent });

      expect(
        [feedback.pageErrorMessage, feedback.offlineSaleErrorMessage].filter(
          (message) => message === `${intent} failed.`,
        ),
      ).toHaveLength(1);
      expect(feedback.offlineSaleErrorMessage).toBe(intent === "record-offline-sale" ? `${intent} failed.` : null);
      expect(feedback.pageErrorMessage).toBe(intent === "record-offline-sale" ? null : `${intent} failed.`);
    },
  );

  it.each([
    ["detail", inventoryItemAction, "http://localhost/account/inventory/items/inv_1", { itemId: "inv_1" }],
    ["list", inventoryAction, "http://localhost/account/inventory", {}],
  ])(
    "submits an offline sale through the landed client from the %s route",
    async (_surface, routeAction, url, params) => {
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request) => {
          const requestUrl = String(input);
          requests.push(requestUrl);
          if (requestUrl.includes("/api/auth/session")) {
            return Promise.resolve(
              jsonResponse({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["inventory.view", "inventory.manage"],
                },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse(
              {
                itemId: "inv_1",
                version: 3,
                requestedQuantity: 2,
                appliedQuantity: 2,
                refusedQuantity: 0,
                collision: null,
              },
              200,
              commitHeaders("77"),
            ),
          );
        }),
      );

      const form = new URLSearchParams({
        intent: "record-offline-sale",
        itemId: "inv_1",
        quantity: "2",
        salePriceAmount: "12.50",
        channel: "card-show",
        note: "Saturday table",
        collisionMode: "protect-orders",
        idempotencyKey: "sale-77",
      });
      const result = await routeAction({
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params,
        context: undefined,
      } as never);

      expect(requests.filter((requestUrl) => requestUrl.includes("/offline-sales"))).toHaveLength(1);
      expect(requests.some((requestUrl) => requestUrl.includes("/adjustments"))).toBe(false);
      expect(result).toMatchObject({
        offlineSale: { itemId: "inv_1", appliedQuantity: 2, refusedQuantity: 0 },
        commandReceipt: { commitPosition: "77" },
      });
    },
  );

  it.each([
    ["detail", inventoryItemAction, "http://localhost/account/inventory/items/inv_1", { itemId: "inv_1" }],
    ["list", inventoryAction, "http://localhost/account/inventory", {}],
  ])(
    "retains the typed %s offline-sale result when HTTP 200 has no consistency receipt",
    async (_surface, routeAction, url, params) => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request) => {
          const requestUrl = String(input);
          if (requestUrl.includes("/api/auth/session")) {
            return Promise.resolve(
              jsonResponse({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["inventory.view", "inventory.manage"],
                },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              itemId: "inv_1",
              version: 3,
              requestedQuantity: 2,
              appliedQuantity: 2,
              refusedQuantity: 0,
              collision: null,
            }),
          );
        }),
      );

      const form = new URLSearchParams({
        intent: "record-offline-sale",
        itemId: "inv_1",
        quantity: "2",
        salePriceAmount: "12.50",
        channel: "card-show",
        collisionMode: "protect-orders",
        idempotencyKey: "sale-replay",
      });
      const result = await routeAction({
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params,
        context: undefined,
      } as never);

      expect(result).toEqual({
        offlineSale: {
          itemId: "inv_1",
          version: 3,
          requestedQuantity: 2,
          appliedQuantity: 2,
          refusedQuantity: 0,
          collision: null,
        },
        commandReceipt: null,
      });
    },
  );

  it("keeps the selected inventory page and reconciles only the receipt-gated offline-sale row from a fresh item read", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const staleItem = {
      item_id: "inv_1",
      account_id: "acc_1",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::condition:near_mint",
      item_title: "Charizard ex",
      item_subtitle: null,
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      product_summary: "Condition: Near Mint",
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "North shelf",
      ship_from_code: "CHI-WH-1",
      ship_from_address: {
        name: "Chase Sets",
        line1: "100 Market St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      total_quantity: 8,
      held_quantity: 1,
      available_quantity: 7,
      acquisition_cost_amount: "4.25",
      acquisition_cost_currency_code: "USD",
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/items/inv_1")) {
          return Promise.resolve(jsonResponse({ ...staleItem, available_quantity: 5, holds: [], ledger: [] }));
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(jsonResponse({ items: [staleItem], total: 31, count: 1, limit: 25, offset: 50 }));
      }),
    );

    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/inventory?limit=25&offset=50&offlineSaleItemId=inv_1",
        inventoryCommit("79"),
      )}`,
    );
    const result = await inventoryLoader({ request, params: {}, context: undefined } as never);
    const freshItemRequest = requests.find((candidate) => candidate.url.includes("/api/inventory/items/inv_1"));

    expect(freshItemRequest?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(result.items).toMatchObject({ total: 31, count: 1, limit: 25, offset: 50 });
    expect(result.items.items[0]?.available_quantity).toBe(5);
    expect(result.offlineSaleFreshItem?.available_quantity).toBe(5);
    expect(result.offlineSaleFreshness).toEqual({ itemId: "inv_1", state: "fresh" });
  });

  it("keeps page rows, totals, and pagination unchanged when the receipt-gated sale item moved off-page", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const pageItem = {
      item_id: "inv_page",
      account_id: "acc_1",
      catalog_catalog_item_id: "cat_page",
      product_id: "cat_page::raw",
      item_title: "Page item",
      item_subtitle: null,
      selected_options: [],
      product_summary: null,
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Main shelf",
      ship_from_code: "STL",
      ship_from_address: null,
      total_quantity: 4,
      held_quantity: 0,
      available_quantity: 4,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    };
    const freshSaleItem = {
      ...pageItem,
      item_id: "inv_1",
      catalog_catalog_item_id: "cat_sale",
      product_id: "cat_sale::raw",
      item_title: "Sold item",
      total_quantity: 2,
      available_quantity: 2,
      holds: [],
      ledger: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }
        if (url.includes("/api/inventory/items/inv_1")) {
          return Promise.resolve(jsonResponse(freshSaleItem));
        }
        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }
        return Promise.resolve(jsonResponse({ items: [pageItem], total: 100, count: 1, limit: 25, offset: 50 }));
      }),
    );

    const result = await inventoryLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/inventory?query=bulba&limit=25&offset=50&offlineSaleItemId=inv_1",
          inventoryCommit("80"),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toMatchObject({ items: [pageItem], total: 100, count: 1, limit: 25, offset: 50 });
    expect(result.offlineSaleFreshItem).toMatchObject({ item_id: "inv_1", available_quantity: 2 });
    expect(result.offlineSaleFreshness).toEqual({ itemId: "inv_1", state: "fresh" });
    expect(
      requests
        .find((request) => request.url.includes("/api/inventory/items/inv_1"))
        ?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER),
    ).toBeTruthy();
  });

  it("keeps a failed receipt-gated off-page read bounded as unverified without changing the page", async () => {
    const pageItem = { item_id: "inv_page", available_quantity: 4 };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }
        if (url.includes("/api/inventory/items/inv_1")) {
          return Promise.resolve(jsonResponse({ error: "Fresh item unavailable." }, 503));
        }
        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }
        return Promise.resolve(jsonResponse({ items: [pageItem], total: 100, count: 1, limit: 25, offset: 50 }));
      }),
    );

    const result = await inventoryLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/inventory?limit=25&offset=50&offlineSaleItemId=inv_1",
          inventoryCommit("81"),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toMatchObject({ items: [pageItem], total: 100, count: 1, limit: 25, offset: 50 });
    expect(result.offlineSaleFreshItem).toBeNull();
    expect(result.offlineSaleFreshness).toEqual({ itemId: "inv_1", state: "unverified" });
  });

  it("keeps the form hidden for a viewer and refuses a forged offline-sale form before calling Inventory", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "viewer",
                permissions: ["inventory.view"],
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const loaderResult = await inventoryLoader({
      request: new Request("http://localhost/account/inventory"),
      params: {},
      context: undefined,
    } as never);
    expect(loaderResult.canRecordOfflineSale).toBe(false);

    const form = new URLSearchParams({ intent: "record-offline-sale", itemId: "inv_1", quantity: "1" });
    await expect(
      inventoryAction({
        request: new Request("http://localhost/account/inventory", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(requests.some((url) => url.includes("/offline-sales"))).toBe(false);
  });
});
