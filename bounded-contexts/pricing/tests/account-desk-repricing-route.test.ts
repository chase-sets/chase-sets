import { afterEach, describe, expect, it, vi } from "vitest";
import { action as listAction, loader as listLoader } from "../routes/marketplace/account-desk-repricing";
import {
  action as detailAction,
  loader as detailLoader,
  repricingActivityFilterFrom,
} from "../routes/marketplace/account-desk-repricing-policy";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const policy = {
  policyId: "rpp_1",
  accountId: "acc_1",
  name: "Undercut raw singles",
  scope: { kind: "all-listings" },
  excludedListingIds: [],
  rules: [],
  maxChangesPerDay: 500,
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};
const halt = { engaged: false, engagedAt: null, releasedAt: null };

type Call = { method: string; url: string; body: string | null };

// Routes the pricing API by method and path; the handler map returns a
// Response per matched route and anything else fails the test loudly.
function stubPricingApi(
  handlers: Record<string, (call: Call) => Response>,
  permissions = ["pricing.view", "pricing.manage"],
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/auth/session")) {
        return jsonResponse({
          actor: {
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions,
          },
        });
      }
      const call = { method: request.method, url: url.pathname + url.search, body: await request.clone().text() };
      calls.push(call);
      const path = url.pathname.replace(/^.*\/account\/repricing-policies/, "");
      const handler = handlers[`${request.method} ${path}`];
      if (!handler) throw new Error(`unexpected pricing API call ${request.method} ${url.pathname}`);
      return handler(call);
    }),
  );
  return calls;
}

function formRequest(url: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(url, { method: "POST", body: form });
}

describe("Seller Desk repricing routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the policy list, halt and recent dry runs", async () => {
    stubPricingApi({
      "GET ": () => jsonResponse([{ ...policy, changesUsedToday: 12 }]),
      "GET /halt": () => jsonResponse(halt),
      "GET /dry-runs": () => jsonResponse([]),
    });

    const result = await listLoader({
      request: new Request("http://localhost/account/desk/repricing"),
      params: {},
      context: undefined,
    } as never);

    expect(result.loadFailed).toBe(false);
    expect(result.policies[0]).toMatchObject({ policyId: "rpp_1", changesUsedToday: 12 });
    expect(result.halt.engaged).toBe(false);
  });

  it("renders the error state when the pricing API is unavailable", async () => {
    stubPricingApi({
      "GET ": () => jsonResponse({ error: { code: "internal" } }, 503),
      "GET /halt": () => jsonResponse(halt),
      "GET /dry-runs": () => jsonResponse([]),
    });

    const result = await listLoader({
      request: new Request("http://localhost/account/desk/repricing"),
      params: {},
      context: undefined,
    } as never);

    expect(result.loadFailed).toBe(true);
    expect(result.policies).toEqual([]);
  });

  it.each([
    ["pause-policy", "POST /rpp_1/pause", "/account/desk/repricing"],
    ["resume-policy", "POST /rpp_1/resume", "/account/desk/repricing"],
    ["engage-halt", "POST /halt", "/account/desk/repricing"],
    ["release-halt", "POST /halt", "/account/desk/repricing"],
  ])("list action %s calls %s and redirects back to the list", async (intent, route, location) => {
    const calls = stubPricingApi({ [route]: () => jsonResponse(route.endsWith("halt") ? halt : policy) });

    const response = await listAction({
      request: formRequest("http://localhost/account/desk/repricing", { intent, policyId: "rpp_1" }),
      params: {},
      context: undefined,
    } as never);

    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe(location);
    expect(calls).toHaveLength(1);
    if (intent.endsWith("halt")) {
      expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ engaged: intent === "engage-halt" });
    }
  });

  it("refuses a repricing action without pricing.manage", async () => {
    const calls = stubPricingApi({}, ["pricing.view"]);

    const response = await listAction({
      request: formRequest("http://localhost/account/desk/repricing", { intent: "engage-halt" }),
      params: {},
      context: undefined,
    } as never).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    expect([401, 403]).toContain((response as Response).status);
    expect(calls).toEqual([]);
  });

  it("loads a policy with its budget and filtered activity page", async () => {
    const calls = stubPricingApi({
      "GET /rpp_1": () => jsonResponse(policy),
      "GET /halt": () => jsonResponse(halt),
      "GET /budget": () => jsonResponse({ day: "2026-09-26", changesUsed: 42 }),
      "GET /rpp_1/activity": () => jsonResponse({ rows: [], next: null, filterCounts: { "floor-binding": 2341 } }),
    });

    const result = await detailLoader({
      request: new Request("http://localhost/account/desk/repricing/rpp_1?filter=floor-binding&after=cur_1"),
      params: { policyId: "rpp_1" },
      context: undefined,
    } as never);

    expect(result.policy.policyId).toBe("rpp_1");
    expect(result.changesUsedToday).toBe(42);
    expect(result.activityFilter).toBe("floor-binding");
    expect(result.activity?.filterCounts).toMatchObject({ "floor-binding": 2341 });
    const activityCall = calls.find((call) => call.url.includes("/activity"));
    expect(activityCall?.url).toContain("filter=floor-binding");
    expect(activityCall?.url).toContain("after=cur_1");
  });

  it("answers 404 for a policy the account does not own", async () => {
    stubPricingApi({
      "GET /rpp_missing": () => jsonResponse({ error: { code: "not_found" } }, 404),
      "GET /halt": () => jsonResponse(halt),
      "GET /budget": () => jsonResponse({ day: "2026-09-26", changesUsed: 0 }),
      "GET /rpp_missing/activity": () => jsonResponse({ error: { code: "not_found" } }, 404),
    });

    const thrown = await detailLoader({
      request: new Request("http://localhost/account/desk/repricing/rpp_missing"),
      params: { policyId: "rpp_missing" },
      context: undefined,
    } as never).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("ignores an unknown activity filter in the URL", () => {
    expect(repricingActivityFilterFrom("floor-binding")).toBe("floor-binding");
    expect(repricingActivityFilterFrom("competitor-listings")).toBeNull();
    expect(repricingActivityFilterFrom(null)).toBeNull();
  });

  it.each([
    ["pause-policy", "POST /rpp_1/pause", "/account/desk/repricing/rpp_1"],
    ["resume-policy", "POST /rpp_1/resume", "/account/desk/repricing/rpp_1"],
    ["delete-policy", "POST /rpp_1/delete", "/account/desk/repricing"],
  ])("policy action %s calls %s and redirects to %s", async (intent, route, location) => {
    stubPricingApi({ [route]: () => jsonResponse(policy) });

    const response = await detailAction({
      request: formRequest("http://localhost/account/desk/repricing/rpp_1", { intent, policyId: "rpp_1" }),
      params: { policyId: "rpp_1" },
      context: undefined,
    } as never);

    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe(location);
  });

  it("returns the localized failure message when a command is rejected", async () => {
    stubPricingApi({ "POST /rpp_1/delete": () => jsonResponse({ error: { code: "conflict" } }, 409) });

    const result = await detailAction({
      request: formRequest("http://localhost/account/desk/repricing/rpp_1", {
        intent: "delete-policy",
        policyId: "rpp_1",
      }),
      params: { policyId: "rpp_1" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({ error: "The repricing change could not be saved. Try again." });
  });
});
