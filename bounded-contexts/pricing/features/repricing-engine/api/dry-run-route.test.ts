import { Hono } from "hono";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PricingApiEnv } from "../../../api";
import { createRepricingDryRunRoutes } from "./dry-run-route";
import { hashRepricingDryRunBody, validateRepricingDryRunBody, type RepricingDryRun } from "./dry-run";
import { dryRunBody, dryRunContext } from "../tests/dry-run-fixture";

const run: RepricingDryRun = {
  dryRunId: "run-a",
  body: dryRunBody,
  bodyHash: hashRepricingDryRunBody(dryRunBody),
  replacingPolicyId: null,
  status: "completed",
  requestedAt: "2026-09-14T00:00:00Z",
  completedAt: "2026-09-14T00:00:01Z",
  consumedAt: null,
  summary: null,
  cursor: null,
  updatedAt: "2026-09-14T00:00:01Z",
};
function buildApp(accountId = "acc_7910", permissions = ["pricing.view", "pricing.manage"], authenticated = true) {
  const services: Parameters<typeof createRepricingDryRunRoutes>[0] = {
    enqueueDryRun: vi.fn(async (input) =>
      input.replacingPolicyId && input.replacingPolicyId !== accountId
        ? null
        : { ...run, body: validateRepricingDryRunBody(input.body, input.sellerAccountId) },
    ),
    getDryRun: vi.fn(async (account, id) => (account === "acc_7910" && id === run.dryRunId ? run : null)),
    listDryRuns: vi.fn(async (account) => (account === "acc_7910" ? [run] : [])),
    listDryRunTraces: vi.fn(async () => []),
    listDryRunEvents: vi.fn(async () => [{ sequence: 1, eventName: "status", data: { status: "completed" as const } }]),
    waitForDryRunEvents: vi.fn(async () => undefined),
  };
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_7910",
        accountId,
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions,
      });
      c.set("context", dryRunContext);
    }
    return next();
  });
  app.route("/dry-runs", createRepricingDryRunRoutes(services));
  return { app, services };
}

describe("repricing dry-run routes", () => {
  it.each(["", "/traces", "/events"])("fences account reads and missing ids identically: %s", async (suffix) => {
    const owner = buildApp();
    const response = await owner.app.request("/dry-runs/run-a" + suffix);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/pricingMode|competitor|sellerAccountId/);
    const foreign = await buildApp("acc_b").app.request("/dry-runs/run-a" + suffix);
    const absent = await owner.app.request("/dry-runs/missing" + suffix);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await foreign.json()).toEqual(await absent.json());
    expect(owner.services.getDryRun).toHaveBeenCalledWith("acc_7910", "run-a");
  });
  it("lists only the account and rejects excessive or malformed limits and outcomes", async () => {
    const { app, services } = buildApp();
    expect((await app.request("/dry-runs?limit=100")).status).toBe(200);
    expect(services.listDryRuns).toHaveBeenCalledWith("acc_7910", 100);
    expect(await (await buildApp("acc_b").app.request("/dry-runs")).json()).toEqual([]);
    for (const limit of ["101", "0", "-1", "1.5", "NaN"]) {
      expect((await app.request("/dry-runs?limit=" + limit)).status).toBe(400);
      expect((await app.request("/dry-runs/run-a/traces?limit=" + limit)).status).toBe(400);
    }
    expect((await app.request("/dry-runs/run-a/traces?outcome=unknown")).status).toBe(400);
    await app.request("/dry-runs/run-a/traces?outcome=changed&after=lst_1&limit=100");
    expect(services.listDryRunTraces).toHaveBeenCalledWith("acc_7910", "run-a", {
      outcome: "changed",
      after: "lst_1",
      limit: 100,
    });
  });
  it("validates synthetic creates without allowing account or replacement spoofing", async () => {
    const { app, services } = buildApp();
    const post = (body: unknown) =>
      app.request("/dry-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ ...dryRunBody, sellerAccountId: "acc_b" })).status).toBe(202);
    expect(services.enqueueDryRun).toHaveBeenCalledWith(
      expect.objectContaining({ sellerAccountId: "acc_7910" }),
      dryRunContext,
    );
    expect((await post({ ...dryRunBody, rules: [] })).status).toBe(400);
    const foreign = await post({ ...dryRunBody, replacingPolicyId: "acc_b" });
    const absent = await post({ ...dryRunBody, replacingPolicyId: "missing" });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await absent.json());
  });
  it.each(["", "/run-a", "/run-a/traces", "/run-a/events"])(
    "enforces read permission and authentication: %s",
    async (path) => {
      expect((await buildApp("acc_7910", [], false).app.request("/dry-runs" + path)).status).toBe(401);
      expect((await buildApp("acc_7910", ["pricing.manage"]).app.request("/dry-runs" + path)).status).toBe(403);
    },
  );
  it("requires manage permission for writes", async () => {
    expect((await buildApp("acc_7910", ["pricing.view"]).app.request("/dry-runs", { method: "POST" })).status).toBe(
      403,
    );
  });
  it("uses the production SSE account limit and releases every stream", async () => {
    const { app, services } = buildApp();
    vi.mocked(services.getDryRun).mockResolvedValue({ ...run, status: "running" });
    vi.mocked(services.listDryRunEvents).mockResolvedValue([]);
    vi.mocked(services.waitForDryRunEvents).mockImplementation(async (_account, _run, signal) => {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const controllers: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 20; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await app.request("/dry-runs/run-a/events", { signal: controller.signal });
        responses.push(response);
        expect(response.status).toBe(200);
      }
      expect((await app.request("/dry-runs/run-a/events")).status).toBe(429);
      const other = buildApp("acc_b");
      vi.mocked(other.services.getDryRun).mockResolvedValue(run);
      const response = await other.app.request("/dry-runs/run-a/events");
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(responses.map((response) => response.body?.cancel()));
    }
  });
  it("hashes only the canonical four-field policy body, retaining ordered rule semantics", () => {
    const reordered = {
      rules: dryRunBody.rules,
      maxChangesPerDay: 100,
      excludedListingIds: [],
      scope: dryRunBody.scope,
    };
    expect(hashRepricingDryRunBody(reordered)).toBe(run.bodyHash);
    expect(hashRepricingDryRunBody({ ...dryRunBody, maxChangesPerDay: 101 })).not.toBe(run.bodyHash);
    expect(hashRepricingDryRunBody({ ...dryRunBody, excludedListingIds: ["lst_1"] })).not.toBe(run.bodyHash);
    const canonical = JSON.stringify({
      excludedListingIds: [],
      maxChangesPerDay: 100,
      rules: [
        {
          conditions: [],
          directive: {
            anchorChain: [{ source: "market-estimate" }],
            ceiling: null,
            currencyCode: "USD",
            floor: { amount: "1.00", mode: "absolute" },
            maxMovePercent: null,
            offset: { amount: "0", mode: "absolute" },
            rounding: { mode: "none" },
            terminal: { amount: "15.00", kind: "fallback-price" },
            tolerance: { amount: "0.01", mode: "absolute" },
          },
        },
      ],
      scope: { kind: "all-listings" },
    });
    expect(run.bodyHash).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });
});
