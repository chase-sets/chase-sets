import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import { action as listAction, loader as listLoader } from "../routes/marketplace/account-desk-repricing";
import {
  action as detailAction,
  loader as detailLoader,
  repricingActivityFilterFrom,
} from "../routes/marketplace/account-desk-repricing-policy";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// The consistency headers a committed pricing command answers with.
function commitHeaders(position: string) {
  return {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_pricing_${position}`,
    [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
      { sourceContextName: "pricing", maxGlobalPosition: position, eventIds: [`evt_pricing_${position}`] },
    ]),
  };
}

function pricingCommit(position: string) {
  return {
    commitPosition: position,
    commitEventIds: [`evt_pricing_${position}`],
    commitPositions: [
      { sourceContextName: "pricing", maxGlobalPosition: position, eventIds: [`evt_pricing_${position}`] },
    ],
  };
}

const projectionTimeout = () =>
  jsonResponse({ error: { code: "projection_freshness_timeout", message: "Projection is catching up." } }, 503);

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

type Call = { method: string; url: string; path: string; body: string | null; headers: Headers };

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
      const path = url.pathname.replace(/^.*\/account\/repricing-policies/, "");
      const call = {
        method: request.method,
        url: url.pathname + url.search,
        path,
        body: await request.clone().text(),
        headers: request.headers,
      };
      calls.push(call);
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

function loaderArgs(href: string, params: Record<string, string> = {}) {
  return { request: new Request(new URL(href, "http://localhost")), params, context: undefined } as never;
}

function freshWriteReceiptOf(call: Call | undefined) {
  return decodeFreshWriteReceipt(call?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER));
}

describe("Seller Desk repricing routes", () => {
  it("creates from the exact completed run and carries the receipt to the list", async () => {
    const calls = stubPricingApi({ "POST ": () => jsonResponse(policy, 201, commitHeaders("51")) });
    const response = (await listAction({
      request: formRequest("http://localhost/account/desk/repricing", {
        intent: "create-policy",
        name: "Synthetic",
        dryRunId: "exact-run",
      }),
      params: {},
      context: undefined,
    } as never)) as Response;
    expect(JSON.parse(calls[0]!.body!)).toEqual({ dryRunId: "exact-run", name: "Synthetic" });
    const location = response.headers.get("Location")!;
    expect(new URL(location, "http://localhost").pathname).toBe("/account/desk/repricing");
    expect(location).toContain("postWriteToken=");
  });
  it("revises without a dry run, forwards the full body and retains the detail receipt", async () => {
    const calls = stubPricingApi({ "POST /rpp_1/revise": () => jsonResponse(policy, 200, commitHeaders("52")) });
    const body = {
      name: "Revised",
      scope: { kind: "all-listings" },
      excludedListingIds: [],
      maxChangesPerDay: 25,
      rules: [],
    };
    const response = (await detailAction({
      request: formRequest("http://localhost/account/desk/repricing/rpp_1", {
        intent: "revise-policy",
        policyId: "rpp_1",
        body: JSON.stringify(body),
      }),
      params: { policyId: "rpp_1" },
      context: undefined,
    } as never)) as Response;
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    const location = response.headers.get("Location")!;
    expect(new URL(location, "http://localhost").pathname).toBe("/account/desk/repricing/rpp_1");
    expect(location).toContain("postWriteToken=");
  });
  it("domain validation details survive the revise action while code-only and 409 responses remain safe", async () => {
    for (const details of [[{ message: "A repricing policy must define at least one rule." }], undefined]) {
      stubPricingApi({
        "POST /rpp_1/revise": () =>
          jsonResponse({ error: { code: "validation_failed", ...(details ? { details } : {}) } }, 400),
      });
      const result = await detailAction({
        request: formRequest("http://localhost/account/desk/repricing/rpp_1", {
          intent: "revise-policy",
          policyId: "rpp_1",
          body: "{}",
        }),
        params: { policyId: "rpp_1" },
        context: undefined,
      } as never);
      expect(result).toMatchObject({ details: details?.map(({ message }) => message) ?? [] });
    }
    stubPricingApi({ "POST ": () => jsonResponse({ error: { code: "dry_run_required" } }, 409) });
    expect(
      await listAction({
        request: formRequest("http://localhost/account/desk/repricing", {
          intent: "create-policy",
          name: "Synthetic",
          dryRunId: "stale",
        }),
        params: {},
        context: undefined,
      } as never),
    ).toMatchObject({ error: "The repricing change could not be saved. Try again.", details: [] });
  });
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

    expect(result).toMatchObject({
      recovery: null,
      policy: { policyId: "rpp_1" },
      changesUsedToday: 42,
      activityFilter: "floor-binding",
      activity: { filterCounts: { "floor-binding": 2341 } },
    });
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
  describe("read after write", () => {
    const listReads = {
      "GET /halt": () => jsonResponse(halt),
      "GET /dry-runs": () => jsonResponse([]),
    };
    const detailReads = {
      "GET /halt": () => jsonResponse(halt),
      "GET /budget": () => jsonResponse({ day: "2026-09-26", changesUsed: 0 }),
      "GET /rpp_1/activity": () => jsonResponse({ rows: [], next: null, filterCounts: {} }),
    };

    it("carries a pause receipt into the list's policy read and nowhere else", async () => {
      stubPricingApi({
        "POST /rpp_1/pause": () => jsonResponse({ ...policy, status: "paused" }, 200, commitHeaders("42")),
      });
      const response = (await listAction({
        request: formRequest("http://localhost/account/desk/repricing", { intent: "pause-policy", policyId: "rpp_1" }),
        params: {},
        context: undefined,
      } as never)) as Response;
      const location = response.headers.get("Location") ?? "";
      expect(response.status).toBe(302);
      expect(new URL(location, "http://localhost").pathname).toBe("/account/desk/repricing");
      expect(location).toContain("postWriteToken=");

      const calls = stubPricingApi({
        "GET ": () => jsonResponse([{ ...policy, status: "paused", changesUsedToday: 0 }]),
        ...listReads,
      });
      const result = await listLoader(loaderArgs(location));

      expect(result).toMatchObject({ catchingUp: false, loadFailed: false, policies: [{ status: "paused" }] });
      const policyRead = calls.find((call) => call.path === "");
      expect(freshWriteReceiptOf(policyRead)).toMatchObject({
        sources: [{ sourceContextName: "pricing", maxGlobalPosition: "42" }],
      });
      expect(policyRead?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("pricing");
      // The `/:policyId` freshness route also matches `/halt`, so the halt and
      // dry-run reads must not forward the receipt.
      for (const call of calls.filter((entry) => entry.path !== "")) {
        expect(call.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
      }
    });

    it.each([
      ["pause-policy", "POST /rpp_1/pause"],
      ["resume-policy", "POST /rpp_1/resume"],
    ])("carries a %s receipt into the policy's own fresh read", async (intent, route) => {
      stubPricingApi({ [route]: () => jsonResponse(policy, 200, commitHeaders("43")) });
      const response = (await detailAction({
        request: formRequest("http://localhost/account/desk/repricing/rpp_1", { intent, policyId: "rpp_1" }),
        params: { policyId: "rpp_1" },
        context: undefined,
      } as never)) as Response;
      const location = response.headers.get("Location") ?? "";
      expect(new URL(location, "http://localhost").pathname).toBe("/account/desk/repricing/rpp_1");
      expect(location).toContain("postWriteToken=");

      const calls = stubPricingApi({ "GET /rpp_1": () => jsonResponse(policy), ...detailReads });
      const result = await detailLoader(loaderArgs(location, { policyId: "rpp_1" }));

      expect(result).toMatchObject({ recovery: null, policy: { policyId: "rpp_1" } });
      expect(freshWriteReceiptOf(calls.find((call) => call.path === "/rpp_1"))).toMatchObject({
        sources: [{ sourceContextName: "pricing", maxGlobalPosition: "43" }],
      });
      for (const call of calls.filter((entry) => entry.path !== "/rpp_1")) {
        expect(call.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
      }
    });

    it.each([
      ["already converged", () => jsonResponse([]), false],
      ["still catching up", projectionTimeout, true],
    ] as const)(
      "never lists a deleted policy after the delete redirect when the projection is %s",
      async (_label, listResponse, catchingUp) => {
        stubPricingApi({
          "POST /rpp_1/delete": () => jsonResponse({ ...policy, status: "deleted" }, 200, commitHeaders("44")),
        });
        const response = (await detailAction({
          request: formRequest("http://localhost/account/desk/repricing/rpp_1", {
            intent: "delete-policy",
            policyId: "rpp_1",
          }),
          params: { policyId: "rpp_1" },
          context: undefined,
        } as never)) as Response;
        const location = response.headers.get("Location") ?? "";
        expect(new URL(location, "http://localhost").pathname).toBe("/account/desk/repricing");

        const calls = stubPricingApi({ "GET ": listResponse, ...listReads });
        const result = await listLoader(loaderArgs(location));

        expect(result).toMatchObject({ policies: [], catchingUp, loadFailed: false });
        expect(freshWriteReceiptOf(calls.find((call) => call.path === ""))).toMatchObject({
          sources: [{ sourceContextName: "pricing", maxGlobalPosition: "44" }],
        });
      },
    );

    it.each([
      ["engage-halt", true],
      ["release-halt", false],
    ] as const)("keeps %s a plain redirect because the halt is read from its aggregate", async (intent, engaged) => {
      const calls = stubPricingApi({
        "POST /halt": () => jsonResponse({ ...halt, engaged }, 200, commitHeaders("45")),
      });
      const response = (await listAction({
        request: formRequest("http://localhost/account/desk/repricing", { intent }),
        params: {},
        context: undefined,
      } as never)) as Response;

      expect(response.headers.get("Location")).toBe("/account/desk/repricing");
      expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ engaged });
    });

    it.each([
      ["a not-found policy", () => jsonResponse({ error: { code: "not_found" } }, 404)],
      ["a projection timeout", projectionTimeout],
    ])("shows bounded recovery for %s behind a live receipt", async (_label, policyResponse) => {
      stubPricingApi({ "GET /rpp_1": policyResponse, ...detailReads });
      const href = appendFreshWriteToken("/account/desk/repricing/rpp_1", pricingCommit("46"));

      const result = await detailLoader(loaderArgs(href, { policyId: "rpp_1" }));

      expect(result).toEqual({ recovery: "catching-up" });
    });

    it.each([
      ["no receipt", "/account/desk/repricing/rpp_1"],
      [
        "an expired receipt",
        appendFreshWriteToken("/account/desk/repricing/rpp_1", pricingCommit("47"), Date.now() - 40_000),
      ],
      ["an unknown compact token", "/account/desk/repricing/rpp_1?postWriteToken=pwt_unknown"],
    ])("answers an ordinary 404 for a missing policy with %s", async (_label, href) => {
      const calls = stubPricingApi({
        "GET /rpp_1": () => jsonResponse({ error: { code: "not_found" } }, 404),
        ...detailReads,
      });

      const thrown = await detailLoader(loaderArgs(href, { policyId: "rpp_1" })).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
      expect(calls.filter((call) => call.path === "/rpp_1")).toHaveLength(1);
    });

    it.each([401, 403])("propagates authorization status %i behind a live receipt", async (status) => {
      const forbidden = () => jsonResponse({ error: { code: "authorization_forbidden" } }, status);
      stubPricingApi({ "GET ": forbidden, ...listReads, "GET /rpp_1": forbidden, ...detailReads });
      const listHref = appendFreshWriteToken("/account/desk/repricing", pricingCommit("48"));
      const detailHref = appendFreshWriteToken("/account/desk/repricing/rpp_1", pricingCommit("48"));

      await expect(listLoader(loaderArgs(listHref))).rejects.toMatchObject({ status });
      await expect(detailLoader(loaderArgs(detailHref, { policyId: "rpp_1" }))).rejects.toMatchObject({ status });
    });
  });
});
