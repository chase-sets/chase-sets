import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PlatformOperationsApiEnv } from "../../../api";
import { createRateLimitPolicyRoutes } from "./rate-limit-policy-route";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(policies: Partial<PolicyRuntime>, permissions: readonly string[]) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "platform-admin",
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createRateLimitPolicyRoutes(policies as PolicyRuntime));
  return app;
}

const sampleValue = { incidentMultiplier: 1, surfaces: {} };

describe("platform-operations rate-limit policy routes", () => {
  it("returns the resolved current policy for security.manage actors", async () => {
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "platform-operations.rate-limits",
      value: sampleValue,
      source: "fallback" as const,
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-07-11T00:00:00.000Z",
    }));
    const app = createApp({ resolvePolicy: resolvePolicy as PolicyRuntime["resolvePolicy"] }, ["security.manage"]);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy_key: "platform-operations.rate-limits",
      source: "fallback",
      value: sampleValue,
    });
  });

  it("requires security.manage to read the current policy", async () => {
    const resolvePolicy = vi.fn();
    const app = createApp({ resolvePolicy }, []);

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it("requires authentication to read the current policy", async () => {
    const app = new Hono<PlatformOperationsApiEnv>();
    app.route("/", createRateLimitPolicyRoutes({} as PolicyRuntime));

    const response = await app.request("/");

    expect(response.status).toBe(401);
  });

  it("creates a rate-limit policy document with an incident multiplier and per-surface overrides", async () => {
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 1 }));
    const app = createApp({ createPolicyDocument }, ["security.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        incidentMultiplier: 2,
        surfaces: { "checkout.anonymous-rail-capture": { max: 10, disabled: false } },
        status: "active",
        effectiveFrom: "2026-07-11T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 1 });
    expect(createPolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "platform-operations.rate-limits" }),
      expect.objectContaining({
        value: {
          incidentMultiplier: 2,
          surfaces: { "checkout.anonymous-rail-capture": { max: 10, disabled: false } },
        },
        status: "active",
        actorUserId: "usr_admin",
      }),
      context,
    );
  });

  it("requires security.manage to revise the policy", async () => {
    const revisePolicyDocument = vi.fn();
    const app = createApp({ revisePolicyDocument }, []);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(revisePolicyDocument).not.toHaveBeenCalled();
  });

  it("revises the rate-limit policy through the admin API", async () => {
    const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 2 }));
    const app = createApp({ revisePolicyDocument }, ["security.manage"]);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({
        incidentMultiplier: 1,
        surfaces: {},
        status: "active",
        effectiveFrom: "2026-07-11T00:00:00.000Z",
        effectiveUntil: null,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 2 });
    expect(revisePolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "platform-operations.rate-limits" }),
      "pol_1",
      expect.objectContaining({ value: { incidentMultiplier: 1, surfaces: {} }, actorUserId: "usr_admin" }),
      context,
    );
  });

  it("surfaces validation failures from the domain decoder as 400s", async () => {
    const createPolicyDocument = vi.fn(async () => {
      throw new Error("Rate-limit incident multiplier must be between 0.1 and 10.");
    });
    const app = createApp({ createPolicyDocument }, ["security.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({ incidentMultiplier: 99, surfaces: {}, status: "active" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed", message: expect.stringContaining("between 0.1 and 10") },
    });
  });

  it("returns 404 for a document id that does not belong to this policy", async () => {
    const getPolicyDocument = vi.fn(async () => ({
      document_id: "pol_other",
      policy_key: "some-other.policy",
      context_name: "platform-operations",
      schema_summary: "test",
      status: "active",
      value: {},
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_until: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      history: [],
    }));
    const app = createApp({ getPolicyDocument }, ["security.manage"]);

    const response = await app.request("/pol_other");

    expect(response.status).toBe(404);
  });
});
