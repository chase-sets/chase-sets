import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { SupportApiEnv } from "./http";
import { createSupportDeadlinePolicyRoutes } from "./deadline-policy-route";
import { SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE } from "../domain/support-deadline-policy";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(policies: Partial<PolicyRuntime>, permissions: readonly string[]) {
  const app = new Hono<SupportApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "admin",
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createSupportDeadlinePolicyRoutes(policies as PolicyRuntime));
  return app;
}

const revisedFlows = {
  ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
  "product-not-received": { sellerResponseHours: 72, supportReviewHours: 36 },
};

describe("support deadline policy routes", () => {
  it("returns the resolved current policy for viewers", async () => {
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "platform-operations.support-deadlines",
      value: SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
      source: "fallback" as const,
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-05-03T00:00:01.000Z",
    }));
    const app = createApp({ resolvePolicy: resolvePolicy as PolicyRuntime["resolvePolicy"] }, ["support.view"]);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy_key: "platform-operations.support-deadlines",
      source: "fallback",
      value: SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
    });
  });

  it("requires view permission to read the current policy", async () => {
    const resolvePolicy = vi.fn();
    const app = createApp({ resolvePolicy }, []);

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it("returns a command snapshot when creating the deadline policy", async () => {
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 1 }));
    const app = createApp({ createPolicyDocument }, ["support.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        flows: revisedFlows,
        status: "active",
        effectiveFrom: "2026-05-03T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 1 });
    expect(createPolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "platform-operations.support-deadlines" }),
      expect.objectContaining({
        value: revisedFlows,
        status: "active",
        actorUserId: "usr_admin",
      }),
      context,
    );
  });

  it("rejects an out-of-bounds revision with a validation error", async () => {
    // Mirrors the real `createPolicyDocument`'s defensive
    // `definition.decodeValue` re-validation before persisting.
    const createPolicyDocument = vi.fn(
      async (definition: { decodeValue: (value: unknown) => unknown }, params: { value: unknown }) => {
        definition.decodeValue(JSON.parse(JSON.stringify(params.value)));
        return { documentId: "pol_1", version: 1 };
      },
    );
    const app = createApp({ createPolicyDocument: createPolicyDocument as PolicyRuntime["createPolicyDocument"] }, [
      "support.manage",
    ]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        flows: {
          ...SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
          "product-not-received": { sellerResponseHours: 2, supportReviewHours: 24 },
        },
        status: "active",
        effectiveFrom: "2026-05-03T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toMatch(/between 4 and 336/);
  });

  it("requires manage permission for policy revisions", async () => {
    const revisePolicyDocument = vi.fn();
    const app = createApp({ revisePolicyDocument }, ["support.view"]);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(revisePolicyDocument).not.toHaveBeenCalled();
  });

  it("revises the deadline policy through the admin API", async () => {
    const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 2 }));
    const app = createApp({ revisePolicyDocument }, ["support.manage"]);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({
        flows: revisedFlows,
        status: "active",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 2 });
    expect(revisePolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "platform-operations.support-deadlines" }),
      "pol_1",
      expect.objectContaining({
        value: revisedFlows,
        actorUserId: "usr_admin",
      }),
      context,
    );
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
    const app = createApp({ getPolicyDocument }, ["support.view"]);

    const response = await app.request("/pol_other");

    expect(response.status).toBe(404);
  });
});
