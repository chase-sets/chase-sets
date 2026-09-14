import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PricingApiEnv } from "../../../api";
import { createRepricingPolicyRoutes } from "./route";
import { createRepricingPolicyRuntime } from "./runtime";
import { DryRunRequiredError } from "./activation";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";

async function fixture() {
  const eventStore = createInMemoryEventStore();
  const db: PgQueryable = { query: async () => ({ rows: [] }) };
  const runtime = createRepricingPolicyRuntime({ eventStore, db });
  const created = await runtime.commandHandler({ streamId: runtime.streamIdForPolicy("rpp_synthetic_7911"), context: dryRunContext,
    command: { ...dryRunBody, type: "CreateRepricingPolicy", policyId: "rpp_synthetic_7911", accountId: "acc_7910", name: "Synthetic", createdAt: "2026-01-01T00:00:00Z" } });
  const services: Parameters<typeof createRepricingPolicyRoutes>[0] = {
    ...runtime,
    getAccountRepricingPolicy: vi.fn(async ({ accountId, policyId }) => accountId === "acc_7910" && policyId === created.state.policyId ? {
      ...dryRunBody, excludedListingIds: [], policyId, sellerAccountId: accountId, name: "Synthetic", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    } : null),
    listAccountRepricingPolicies: vi.fn(async ({ accountId }) => accountId === "acc_7910" ? [{
      ...dryRunBody, excludedListingIds: [], policyId: "rpp_synthetic_7911", sellerAccountId: accountId, name: "Synthetic", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }] : []),
    getBudget: vi.fn(async (accountId, day) => ({ day, changesUsed: accountId === "acc_7910" ? 4 : 0 })),
    listCategories: vi.fn(async (accountId) => [{ id: "category_synthetic", name: "Synthetic", status: "active", listingCount: accountId === "acc_7910" ? 2 : 0 }]),
    previewScope: vi.fn(async ({ accountId }) => ({ matching: accountId === "acc_7910" ? 2 : 0, governed: accountId === "acc_7910" ? 2 : 0, shadowedBy: [], takenFrom: [] })),
    activateRepricingPolicy: vi.fn(async ({ accountId, dryRunId }) => {
      if (accountId !== "acc_7910" || dryRunId === "missing") return null;
      if (dryRunId !== "completed") throw new DryRunRequiredError();
      return created.state;
    }),
  };
  function app(accountId = "acc_7910", permissions = ["pricing.view", "pricing.manage"], authenticated = true) {
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      if (authenticated) {
        c.set("actor", { sessionId: "ses_synthetic", tenantId: "tnt_identity", userId: "usr_synthetic", accountId, membershipId: "mbr_synthetic", roleKey: "owner", permissions });
        c.set("context", { ...dryRunContext, audit: { ...dryRunContext.audit, forAccountId: accountId } });
      }
      return next();
    });
    app.route("/policies", createRepricingPolicyRoutes(services));
    return app;
  }
  return { app, services, eventStore };
}
const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("account policy controls", () => {
  it.each(["", "/revise", "/pause", "/resume", "/delete"])("foreign and absent policy ids share 404: %s", async (suffix) => {
    const { app, eventStore } = await fixture();
    const request = suffix ? post({ ...dryRunBody, name: "Revised" }) : undefined;
    const before = await eventStore.readAll();
    const foreign = await app("acc_b").request("/policies/rpp_synthetic_7911" + suffix, request);
    const missing = await app().request("/policies/rpp_missing" + suffix, request);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await eventStore.readAll()).toEqual(before);
    expect((await app().request("/policies/rpp_synthetic_7911" + suffix, request)).status).toBe(200);
  });
  it("owns commands from the aggregate before projection catchup and leaves revise/resume ungated", async () => {
    const { app, services } = await fixture();
    services.getAccountRepricingPolicy = vi.fn(async () => null);
    for (const [action, body] of [["pause", {}], ["resume", {}], ["revise", { ...dryRunBody, name: "Revised" }], ["delete", {}]] as const) {
      const response = await app().request(`/policies/rpp_synthetic_7911/${action}`, post(body));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ policyId: "rpp_synthetic_7911", accountId: "acc_7910" });
    }
    expect(services.getAccountRepricingPolicy).not.toHaveBeenCalled();
    expect(services.activateRepricingPolicy).not.toHaveBeenCalled();
  });
  it("self-scoped list, halt, budget, categories and preview isolate accounts rather than claiming foreign-id 404", async () => {
    const { app, services } = await fixture();
    expect(await (await app().request("/policies")).json()).toEqual([expect.objectContaining({ changesUsedToday: 4 })]);
    expect(await (await app("acc_b").request("/policies")).json()).toEqual([]);
    expect((await app().request("/policies/halt", post({ engaged: true }))).status).toBe(200);
    expect(await (await app().request("/policies/halt")).json()).toMatchObject({ engaged: true });
    expect(await (await app("acc_b").request("/policies/halt")).json()).toMatchObject({ engaged: false });
    expect((await app("acc_b").request("/policies/halt", post({ engaged: false }))).status).toBe(200);
    for (const accountId of ["acc_7910", "acc_b"]) {
      const owner = accountId === "acc_7910";
      expect(await (await app(accountId).request("/policies/budget?day=2026-09-14")).json()).toEqual({ day: "2026-09-14", changesUsed: owner ? 4 : 0 });
      expect(await (await app(accountId).request("/policies/categories")).json()).toEqual([expect.objectContaining({ listingCount: owner ? 2 : 0 })]);
      expect(await (await app(accountId).request("/policies/scope-preview", post({ scope: { kind: "all-listings" }, accountId: "acc_foreign" }))).json()).toMatchObject({ matching: owner ? 2 : 0 });
      expect(services.previewScope).toHaveBeenLastCalledWith({ scope: { kind: "all-listings" }, accountId });
    }
    for (const id of ["rpp_synthetic_7911", "missing"]) {
      expect((await app("acc_b").request("/policies/scope-preview", post({ scope: { kind: "all-listings" }, replacingPolicyId: id }))).status).toBe(404);
    }
  });
  it("accepts only the settled create shape and translates missing, foreign, and invalid dry runs", async () => {
    const { app } = await fixture();
    expect((await app().request("/policies", post({ name: "Synthetic" }))).status).toBe(409);
    for (const id of ["invalid", "failed", "cancelled", "consumed", "mismatched"]) {
      expect((await app().request("/policies", post({ name: "Synthetic", dryRunId: id }))).status).toBe(409);
    }
    expect((await app().request("/policies", post({ name: "Synthetic", dryRunId: "missing" }))).status).toBe(404);
    expect((await app("acc_b").request("/policies", post({ name: "Synthetic", dryRunId: "completed" }))).status).toBe(404);
    const created = await app().request("/policies", post({ name: "Synthetic", dryRunId: "completed" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ status: "active", accountId: "acc_7910" });
  });
  it("enforces pricing.view for reads and pricing.manage for writes", async () => {
    const { app } = await fixture();
    expect((await app("acc_7910", [], false).request("/policies")).status).toBe(401);
    for (const path of ["", "/halt", "/budget", "/categories", "/rpp_synthetic_7911"]) {
      expect((await app("acc_7910", ["pricing.manage"]).request("/policies" + path)).status).toBe(403);
    }
    for (const path of ["", "/halt", "/scope-preview", "/rpp_synthetic_7911/revise", "/rpp_synthetic_7911/pause", "/rpp_synthetic_7911/resume", "/rpp_synthetic_7911/delete"]) {
      expect((await app("acc_7910", ["pricing.view"]).request("/policies" + path, post())).status).toBe(403);
    }
  });
});
