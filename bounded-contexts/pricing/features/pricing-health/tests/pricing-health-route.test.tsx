import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import { createPricingHealthRoutes } from "../api/route";
import { PricingHealthCandidateRefusedError, type PricingHealthServices } from "../api/services";
import { GoalComparisonValidationError } from "../api/goal-comparison";
import contextManifest from "../../../context.json";
import { SELLER_DESK_SURFACES } from "../../../../../contracts/seller-desk";
import PricingHealthRoute, { action, loader } from "../../../routes/marketplace/account-desk-pricing-health";

afterEach(() => vi.unstubAllGlobals());

function setup(permissions: string[] | null = ["pricing.view", "pricing.manage"]) {
  const services = {
    getHealth: vi
      .fn<PricingHealthServices["getHealth"]>()
      .mockResolvedValue({ policies: [], target: null, health: null, run: null, grades: [], computing: false }),
    compute: vi.fn<PricingHealthServices["compute"]>().mockResolvedValue(null),
    compare: vi.fn<PricingHealthServices["compare"]>().mockResolvedValue(null),
  } satisfies PricingHealthServices;
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    if (permissions) c.set("actor", { accountId: "acc_owned", permissions } as never);
    c.set("context", { tenantId: "tnt_synthetic", audit: {} } as never);
    return next();
  });
  app.route("/health", createPricingHealthRoutes(services));
  return { app, services };
}

describe("Pricing Health route", () => {
  it("reports candidate refusal explicitly instead of accepting an incomplete compare", async () => {
    const { app, services } = setup();
    services.compare.mockRejectedValue(new PricingHealthCandidateRefusedError());
    const response = await app.request("/health/rpp_owned/compare", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "candidate_enqueue_refused" } });
  });
  it("reports whole-request goal validation as 400", async () => {
    const { app, services } = setup();
    services.compare.mockRejectedValue(new GoalComparisonValidationError(["duplicate goal fixed-percentile@1"]));
    const response = await app.request("/health/rpp_owned/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goals: [
          { goalId: "fixed-percentile", goalVersion: 1, parameters: { percentile: 65 } },
          { goalId: "fixed-percentile", goalVersion: 1, parameters: { percentile: 66 } },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
  it("registers the canonical Seller Desk page and authorized route", () => {
    expect(
      readFileSync(new URL("../../../../../contracts/seller-desk/blueprint.md", import.meta.url), "utf8"),
    ).toContain("| Pricing Health | page | `/pricing-health` |");
    expect(SELLER_DESK_SURFACES.find(({ id }) => id === "pricing-health")).toMatchObject({
      kind: "page",
      routePath: "/account/desk/pricing-health",
    });
    const route = contextManifest.deployableContributions
      .flatMap(({ routes }) => routes ?? [])
      .find(({ routeId }) => routeId === "account-desk-pricing-health");
    expect(route).toMatchObject({
      routePath: "account/desk/pricing-health",
      authorization: { requiredPermissions: ["pricing.view"] },
      linkParameters: { query: { policyId: { kind: "value", maxLength: 256 } } },
    });
  });

  it("composes the production link catalog with the explicit policy selector", async () => {
    const { links } = await import("../../../support/runtime-support/link-intents");
    expect(links("account-desk-pricing-health", { path: {}, query: { policyId: "rpp_owned" } }).url).toBe(
      "https://marketplace.chasesets.com/account/desk/pricing-health?policyId=rpp_owned",
    );
  });

  it.each([
    [null, 401],
    [[], 403],
  ] as const)("refuses unauthorized reads %j", async (permissions, status) => {
    const { app, services } = setup(permissions === null ? null : [...permissions]);
    expect((await app.request("/health")).status).toBe(status);
    expect(services.getHealth).not.toHaveBeenCalled();
  });

  it("scopes GET to the actor and never computes", async () => {
    const { app, services } = setup();
    expect((await app.request("/health?policyId=pol_owned")).status).toBe(200);
    expect(services.getHealth).toHaveBeenCalledWith("acc_owned", "pol_owned", expect.any(String));
    expect(services.compute).not.toHaveBeenCalled();
    expect((await app.request("/health?accountId=acc_foreign")).status).toBe(400);
  });

  it("returns identical not-found for absent, inactive and foreign targets", async () => {
    const { app, services } = setup();
    services.getHealth.mockResolvedValue(null);
    for (const policyId of ["missing", "foreign", "paused"])
      expect(await (await app.request(`/health?policyId=${policyId}`)).json()).toEqual({
        error: { code: "not_found" },
      });
  });

  it("Compute verdict retains the existing dry-run manage permission", async () => {
    const readOnly = setup(["pricing.view"]);
    expect((await readOnly.app.request("/health/pol_owned/compute", { method: "POST" })).status).toBe(403);
    expect(readOnly.services.compute).not.toHaveBeenCalled();
    const { app, services } = setup();
    services.compute.mockResolvedValue({ dryRunId: "synthetic-run" } as never);
    expect((await app.request("/health/pol_owned/compute", { method: "POST" })).status).toBe(202);
    expect(services.compute).toHaveBeenCalledWith("acc_owned", "pol_owned", expect.anything());
    services.compute.mockResolvedValue(null);
    expect((await app.request("/health/foreign/compute", { method: "POST" })).status).toBe(404);
  });
});

describe("Mounted Pricing Health loader and action", () => {
  it("renders the mounted route with canonical selector and compute forms", () => {
    const Stub = createRoutesStub([
      {
        path: "/account/desk/pricing-health",
        Component: PricingHealthRoute,
        loader: () => null,
      },
    ]);
    const html = renderToStaticMarkup(
      <Stub
        initialEntries={["/account/desk/pricing-health"]}
        hydrationData={{
          loaderData: {
            "0": {
              data: {
                policies: [
                  { policyId: "rpp_owned", name: "Owned policy" },
                  { policyId: "rpp_second", name: "Second policy" },
                ],
                target: { policyId: "rpp_owned", name: "Owned policy", version: 1 },
                health: null,
                run: null,
                grades: [],
                computing: false,
                canCompute: true,
              },
              loadFailed: false,
            },
          },
        }}
      />,
    );
    expect(html).toContain("Show verdict");
    expect(html).toContain("Compute verdict");
    expect(html).toContain('method="get"');
    expect(html).toContain('method="post"');
  });

  function transport(status = 200, permissions = ["pricing.view", "pricing.manage"]) {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/api/auth/session")
        return Response.json({ actor: { accountId: "acc_owned", permissions } });
      calls.push(request);
      return Response.json(
        status === 200
          ? {
              policies: [],
              target: null,
              health: null,
              run: null,
              grades: [],
              computing: false,
              canCompute: permissions.includes("pricing.manage"),
            }
          : { error: { code: status === 404 ? "not_found" : "source_failure" } },
        { status },
      );
    });
    return calls;
  }

  it("the mounted loader forwards exactly the explicit selector through the typed API client", async () => {
    const calls = transport();
    expect(
      await loader({
        request: new Request("http://localhost/account/desk/pricing-health?policyId=pol_explicit"),
        params: {},
        context: {},
      } as never),
    ).toMatchObject({ data: { health: null }, loadFailed: false });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/marketplace/account/pricing-health");
    expect(new URL(calls[0]!.url).search).toBe("?policyId=pol_explicit");
    expect(calls[0]!.method).toBe("GET");
  });

  it("foreign API not-found remains route not-found while outages have retryable UI", async () => {
    transport(404);
    await expect(
      loader({
        request: new Request("http://localhost/account/desk/pricing-health?policyId=foreign"),
        params: {},
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    transport(503);
    expect(
      await loader({
        request: new Request("http://localhost/account/desk/pricing-health"),
        params: {},
        context: {},
      } as never),
    ).toEqual({ data: null, loadFailed: true });
  });

  it("loader and form authorization happen before any health API call", async () => {
    const calls = transport(200, []);
    const request = new Request("http://localhost/account/desk/pricing-health");
    await expect(loader({ request, params: {}, context: {} } as never)).rejects.toMatchObject({ status: 403 });
    const form = new FormData();
    form.set("intent", "compute");
    form.set("policyId", "pol_explicit");
    await expect(
      action({ request: new Request(request.url, { method: "POST", body: form }), params: {}, context: {} } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it("explicit Compute verdict POST redirects back to the same policy without doing a GET write", async () => {
    const calls = transport();
    const form = new FormData();
    form.set("intent", "compute");
    form.set("policyId", "pol_explicit");
    const result = await action({
      request: new Request("http://localhost/account/desk/pricing-health", { method: "POST", body: form }),
      params: {},
      context: {},
    } as never);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/account/desk/pricing-health?policyId=pol_explicit");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/marketplace/account/pricing-health/pol_explicit/compute");
  });
});
