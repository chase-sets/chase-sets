import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { MarketplaceApiEnv } from "../../../api";
import { createListingGatePolicyRoutes } from "./listing-gate-policy-route";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(policies: Partial<PolicyRuntime>, permissions: readonly string[]) {
  const app = new Hono<MarketplaceApiEnv>();
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
  app.route("/", createListingGatePolicyRoutes(policies as PolicyRuntime));
  return app;
}

const samplePolicyValue = {
  highDollarListingAmount: "250.00",
  minTrustedReputationReviews: 3,
  maxActiveAnonymousListingDrafts: 20,
  anonymousListingDraftTtlDays: 30,
  maxListingPhotoUploadBytes: 10 * 1024 * 1024,
};

describe("marketplace listing-gate policy routes", () => {
  it("returns the resolved current policy for viewers", async () => {
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "marketplace.listing-gate",
      value: samplePolicyValue,
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-05-03T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-05-03T00:00:01.000Z",
    }));
    const getPolicyDocument = vi.fn(async () => ({
      document_id: "pol_1",
      policy_key: "marketplace.listing-gate",
      context_name: "marketplace",
      schema_summary: "test",
      status: "active",
      value: samplePolicyValue,
      effective_from: "2026-05-03T00:00:00.000Z",
      effective_until: null,
      created_at: "2026-05-03T00:00:00.000Z",
      updated_at: "2026-05-03T00:00:00.000Z",
      history: [],
    }));
    const app = createApp({ resolvePolicy: resolvePolicy as PolicyRuntime["resolvePolicy"], getPolicyDocument }, [
      "listings.view",
    ]);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy_key: "marketplace.listing-gate",
      source: "policy",
      document_id: "pol_1",
      value: samplePolicyValue,
    });
  });

  it("requires view permission to read the current policy", async () => {
    const resolvePolicy = vi.fn();
    const app = createApp({ resolvePolicy }, []);

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it("returns a command snapshot when creating the listing-gate policy", async () => {
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 1 }));
    const app = createApp({ createPolicyDocument }, ["listings.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        highDollarListingAmount: "250.00",
        minTrustedReputationReviews: 3,
        maxActiveAnonymousListingDrafts: 20,
        anonymousListingDraftTtlDays: 30,
        maxListingPhotoUploadBytes: 10 * 1024 * 1024,
        status: "active",
        effectiveFrom: "2026-05-03T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 1 });
    expect(createPolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "marketplace.listing-gate" }),
      expect.objectContaining({
        value: samplePolicyValue,
        status: "active",
        actorUserId: "usr_admin",
      }),
      context,
    );
  });

  it("requires manage permission for policy revisions", async () => {
    const revisePolicyDocument = vi.fn();
    const app = createApp({ revisePolicyDocument }, ["listings.view"]);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(revisePolicyDocument).not.toHaveBeenCalled();
  });

  it("revises the listing-gate policy through the admin API", async () => {
    const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 2 }));
    const app = createApp({ revisePolicyDocument }, ["listings.manage"]);

    const response = await app.request("/pol_1", {
      method: "PUT",
      body: JSON.stringify({
        highDollarListingAmount: "500.00",
        minTrustedReputationReviews: 5,
        maxActiveAnonymousListingDrafts: 10,
        anonymousListingDraftTtlDays: 14,
        maxListingPhotoUploadBytes: 5 * 1024 * 1024,
        status: "active",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 2 });
    expect(revisePolicyDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "marketplace.listing-gate" }),
      "pol_1",
      expect.objectContaining({
        value: {
          highDollarListingAmount: "500.00",
          minTrustedReputationReviews: 5,
          maxActiveAnonymousListingDrafts: 10,
          anonymousListingDraftTtlDays: 14,
          maxListingPhotoUploadBytes: 5 * 1024 * 1024,
        },
        actorUserId: "usr_admin",
      }),
      context,
    );
  });

  it("returns 404 for a document id that does not belong to this policy", async () => {
    const getPolicyDocument = vi.fn(async () => ({
      document_id: "pol_other",
      policy_key: "some-other.policy",
      context_name: "marketplace",
      schema_summary: "test",
      status: "active",
      value: {},
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_until: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      history: [],
    }));
    const app = createApp({ getPolicyDocument }, ["listings.view"]);

    const response = await app.request("/pol_other");

    expect(response.status).toBe(404);
  });
});
