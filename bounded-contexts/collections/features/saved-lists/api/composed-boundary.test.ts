import type { RateLimitRule } from "@chase-sets/http/rate-limit";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildCollectionsApi, type CollectionsApiEnv } from "../../../api";
import { createCollectionsServices } from "../../../support/runtime-support/services";

const capturePath = "/guest/saved-list-intents";
const unknownGuestPath = "/guest/deliberately-unknown";
const captureBody = {
  sourcePath: "/search?q=dragon",
  sourceSurface: "search",
  product: {
    catalogItemId: "cit_dragon",
    productId: "prd_dragon_red",
    selectedOptions: [{ dimensionId: "color", optionId: "red" }],
  },
  productSummary: "Red dragon",
};

function captureRequest(anonymousOwnerId?: string): RequestInit {
  const headers = new Headers({ "content-type": "application/json" });
  if (anonymousOwnerId) {
    headers.set("x-collections-anonymous-saved-list-id", anonymousOwnerId);
  }
  return {
    method: "POST",
    headers,
    body: JSON.stringify(captureBody),
  };
}

function buildApi(overrides: Record<string, unknown> = {}) {
  return buildCollectionsApi({
    discovery: {
      createAnonymousIntent: vi.fn(async () => ({ id: "sli_guest" })),
    },
    savedListReadModels: {},
    savedListValuation: {},
    ...overrides,
  } as never);
}

function withActor(app: ReturnType<typeof buildCollectionsApi>) {
  const root = new Hono<CollectionsApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_owner", permissions: ["accounts.view"] });
    c.set("context", {} as CollectionsApiEnv["Variables"]["context"]);
    await next();
  });
  root.route("/", app);
  return root;
}

async function expectRateLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
}

describe("Saved List composed actor boundary", () => {
  it("analytics-composition forwards one recorder through services and both composed routes", async () => {
    const record = vi.fn();
    const recorder = { record };
    expect(
      createCollectionsServices({} as never, { savedListAnalyticsRecorder: recorder }).savedListAnalyticsRecorder,
    ).toBe(recorder);
    const app = withActor(
      buildApi({
        discovery: {
          createAnonymousIntent: vi.fn(),
          addProduct: vi.fn(async () => ({
            response: {
              command: { receipt: { replayed: false, lineResults: [{ status: "added" }] }, savedList: { lines: [{}] } },
              lineStatus: "added",
              listId: "svl_x",
              title: "List",
              alreadyClaimed: false,
              analyticsLabel: "saved-list.added",
            },
          })),
        },
        savedListValuation: {
          getOwnerValuation: vi.fn(async () => ({
            summary: {
              coverage: {
                priced: { lines: 0 },
                total: { lines: 0 },
                missing: { lines: 0 },
                stale: { lines: 0 },
                lowConfidence: { lines: 0 },
              },
            },
          })),
        },
        savedListAnalyticsRecorder: recorder,
      }),
    );
    const addition = await app.request("/account/list-additions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destination: { kind: "existing", listId: "svl_x" },
        addCommandId: "slc_x",
        lineId: "sll_x",
        product: { catalogItemId: "cat_x", productId: "cat_x::condition:near-mint", selectedOptions: [] },
        trackedQuantity: 1,
        sourceSurface: "search",
      }),
    });
    expect(addition.status).toBe(200);
    expect((await app.request("/saved-lists/svl_x/valuation")).status).toBe(200);
    expect(record.mock.calls.map(([item]) => item.event)).toEqual(["product_added", "valuation_coverage_band"]);
  });
  it("admits one actorless guest capture before the actor fence", async () => {
    const createAnonymousIntent = vi.fn(async () => ({ id: "sli_guest" }));
    const app = buildApi({ discovery: { createAnonymousIntent } });

    const response = await app.request(capturePath, captureRequest("anon_owner_a"));

    expect(response.status).toBe(201);
    expect(createAnonymousIntent).toHaveBeenCalledOnce();
    expect(createAnonymousIntent).toHaveBeenCalledWith({
      ...captureBody,
      anonymousOwnerId: "anon_owner_a",
    });
  });

  it("rejects a missing opaque owner before policy lookup or durable capture", async () => {
    const createAnonymousIntent = vi.fn();
    const rateLimitPolicyResolver = vi.fn();
    const app = buildApi({ discovery: { createAnonymousIntent }, rateLimitPolicyResolver });

    const response = await app.request(capturePath, captureRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "anonymous_saved_list_required" },
    });
    expect(rateLimitPolicyResolver).not.toHaveBeenCalled();
    expect(createAnonymousIntent).not.toHaveBeenCalled();
  });

  it("rejects an invalid opaque owner before policy lookup or durable capture", async () => {
    const createAnonymousIntent = vi.fn();
    const rateLimitPolicyResolver = vi.fn();
    const app = buildApi({ discovery: { createAnonymousIntent }, rateLimitPolicyResolver });

    const response = await app.request(capturePath, captureRequest("browser-controlled"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "anonymous_saved_list_required" },
    });
    expect(rateLimitPolicyResolver).not.toHaveBeenCalled();
    expect(createAnonymousIntent).not.toHaveBeenCalled();
  });

  it("limits each opaque owner independently and preserves the aggregate policy surface", async () => {
    const createAnonymousIntent = vi.fn(async () => ({ id: "sli_guest" }));
    const rateLimitPolicyResolver = vi.fn(async (_surface: string, defaults: RateLimitRule) => defaults);
    const app = buildApi({ discovery: { createAnonymousIntent }, rateLimitPolicyResolver });

    for (let requestNumber = 1; requestNumber <= 30; requestNumber += 1) {
      const admitted = await app.request(capturePath, captureRequest("anon_owner_a"));
      expect(admitted.status, `request ${requestNumber}`).toBe(201);
    }

    await expectRateLimited(await app.request(capturePath, captureRequest("anon_owner_a")));
    expect((await app.request(capturePath, captureRequest("anon_owner_b"))).status).toBe(201);
    expect(createAnonymousIntent).toHaveBeenCalledTimes(31);
    expect(rateLimitPolicyResolver).toHaveBeenCalledWith("collections.saved-list.anonymous-capture", {
      max: 30,
      windowMs: 10 * 60 * 1000,
    });
    expect(rateLimitPolicyResolver).toHaveBeenCalledWith("collections.saved-list.anonymous-capture-surface", {
      max: 3_000,
      windowMs: 10 * 60 * 1000,
    });
    expect(new Set(rateLimitPolicyResolver.mock.calls.map(([surface]) => surface))).toEqual(
      new Set(["collections.saved-list.anonymous-capture", "collections.saved-list.anonymous-capture-surface"]),
    );
    expect(JSON.stringify(rateLimitPolicyResolver.mock.calls)).not.toContain("anon_owner");
  });

  it("does not charge owner-limited requests and stops distinct owners at the aggregate ceiling", async () => {
    const createAnonymousIntent = vi.fn(async () => ({ id: "sli_guest" }));
    const rateLimitPolicyResolver = vi.fn(async (surface: string, defaults: RateLimitRule) => {
      if (surface === "collections.saved-list.anonymous-capture") return { ...defaults, max: 1 };
      if (surface === "collections.saved-list.anonymous-capture-surface") return { ...defaults, max: 2 };
      return defaults;
    });
    const app = buildApi({ discovery: { createAnonymousIntent }, rateLimitPolicyResolver });

    expect((await app.request(capturePath, captureRequest("anon_owner_a"))).status).toBe(201);
    await expectRateLimited(await app.request(capturePath, captureRequest("anon_owner_a")));
    expect((await app.request(capturePath, captureRequest("anon_owner_b"))).status).toBe(201);
    await expectRateLimited(await app.request(capturePath, captureRequest("anon_owner_c")));
    expect(createAnonymousIntent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["recent Lists", "GET", "/account/lists/recent"],
    ["List addition", "POST", "/account/list-additions"],
    ["intent preparation", "GET", "/account/saved-list-intents/sli_private"],
    ["intent claim", "POST", "/account/saved-list-intents/sli_private/claim"],
    ["Saved Lists query", "GET", "/saved-lists"],
    ["Saved List detail", "GET", "/saved-lists/svl_private"],
    ["Saved List valuation", "GET", "/saved-lists/svl_private/valuation"],
  ])("keeps actorless %s behind the actor fence", async (_label, method, path) => {
    const downstreamCall = vi.fn();
    const app = buildApi({
      discovery: {
        createAnonymousIntent: vi.fn(),
        listRecent: downstreamCall,
        addProduct: downstreamCall,
        prepareAnonymousClaim: downstreamCall,
        claimAnonymousIntent: downstreamCall,
      },
      savedListReadModels: {
        loadMyCollectionModule: downstreamCall,
        loadDetail: downstreamCall,
      },
      savedListValuation: { getOwnerValuation: downstreamCall },
    });

    const response = await app.request(path, { method });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "authentication_required" },
    });
    expect(downstreamCall).not.toHaveBeenCalled();
  });

  it("returns 404 for an actor-present unknown path after the actor fence", async () => {
    const response = await withActor(buildApi()).request(unknownGuestPath);

    expect(response.status).toBe(404);
  });

  it("returns the indistinguishable 401 for an actorless unknown path", async () => {
    const response = await buildApi().request(unknownGuestPath);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "authentication_required" },
    });
  });
});
