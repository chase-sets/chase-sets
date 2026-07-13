import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import type { ListingEvidencePolicyRuntime } from "./runtime";
import { createListingEvidencePolicyRoutes } from "./route";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_admin" as never, forAccountId: "acc_admin" as never },
};

function createApp(runtime: Partial<ListingEvidencePolicyRuntime>, permissions: readonly string[]) {
  const app = new Hono<MarketplaceApiEnv>();
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
  app.route("/", createListingEvidencePolicyRoutes(runtime as ListingEvidencePolicyRuntime));
  return app;
}

describe("Listing Evidence Policy API", () => {
  it("keeps view, draft, validate, and activate permissions distinct", async () => {
    const runtime = {
      getOverview: vi.fn(),
      createDraft: vi.fn(),
      validateDraft: vi.fn(),
      activateDraft: vi.fn(),
    };
    const app = createApp(runtime, ["listing-evidence-policy.view"]);

    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/drafts", { method: "POST" })).status).toBe(403);
    expect((await app.request("/drafts/pol_1/validate", { method: "POST" })).status).toBe(403);
    expect((await app.request("/drafts/pol_1/activate", { method: "POST" })).status).toBe(403);
    expect(runtime.createDraft).not.toHaveBeenCalled();
  });

  it("returns the committed draft snapshot", async () => {
    const createDraft = vi.fn(async () => ({ documentId: "pol_draft", version: 1 }));
    const app = createApp({ createDraft }, ["listing-evidence-policy.draft"]);

    const response = await app.request("/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policyName: "July policy", rules: [] }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ policyId: "pol_draft", version: 1, lifecycle: "draft" });
    expect(createDraft).toHaveBeenCalledWith(
      { policyName: "July policy", rules: [], actorUserId: "usr_admin" },
      context,
    );
  });

  it("returns validation diagnostics and impact as an unprocessable result", async () => {
    const validateDraft = vi.fn(async () => ({
      documentId: "pol_draft",
      version: 1,
      valid: false,
      diagnostics: [{ code: "invalid_reference", path: "optionIds", message: "Missing option" }],
      policyHash: "sha256:policy",
      semanticDiff: { addedRuleIds: [], changedRuleIds: [], removedRuleIds: [] },
      impactPreview: { impactedListingCount: 0, sample: [], previewHash: "sha256:impact" },
    }));
    const app = createApp({ validateDraft }, ["listing-evidence-policy.validate"]);

    const response = await app.request("/drafts/pol_draft/validate", { method: "POST" });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ valid: false, policyHash: "sha256:policy" });
  });

  it("requires an explicit effective time and current impact acknowledgment to activate", async () => {
    const activateDraft = vi.fn(async () => {
      throw new Error("An explicit effective time is required before activation.");
    });
    const app = createApp({ activateDraft }, ["listing-evidence-policy.activate"]);

    const response = await app.request("/drafts/pol_draft/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impactAcknowledgmentHash: "sha256:impact" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "activation_rejected" } });
    expect(activateDraft).toHaveBeenCalledWith(
      "pol_draft",
      expect.objectContaining({ effectiveFrom: "", impactAcknowledgmentHash: "sha256:impact" }),
      context,
    );
  });
});
