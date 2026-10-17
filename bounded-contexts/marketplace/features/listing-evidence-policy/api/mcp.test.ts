import { describe, expect, it, vi } from "vitest";
import type { McpToolHandlerInput } from "@chase-sets/platform-runtime/mcp";
import { createListingEvidencePolicyMcpHandlers } from "./mcp";
import type { ListingEvidencePolicyRuntime } from "./runtime";

const actor = {
  userId: "usr_operator",
  accountId: "acc_operator",
  tenantId: "tnt_test",
  permissions: [
    "listing-evidence-policy.view",
    "listing-evidence-policy.draft",
    "listing-evidence-policy.validate",
    "listing-evidence-policy.activate",
  ],
} as unknown as McpToolHandlerInput["actor"];

function input(arguments_: Record<string, unknown>): McpToolHandlerInput {
  return {
    actor,
    arguments: arguments_,
    tool: {} as McpToolHandlerInput["tool"],
    request: new Request("https://test"),
    protocol: {} as McpToolHandlerInput["protocol"],
  };
}

function createRuntime() {
  return {
    getOverview: vi.fn(async () => ({ policyKey: "marketplace.listing-evidence" })),
    loadSelectorCatalog: vi.fn(async () => ({ catalogItems: [] })),
    createDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 1 })),
    validateDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 2, valid: true })),
    rejectDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 3 })),
    createRollbackDraft: vi.fn(async () => ({ documentId: "pol_rollback", version: 1 })),
    activateDraft: vi.fn(async () => ({ policyId: "pol_active", version: 1, policyHash: "sha256:active" })),
  } as unknown as ListingEvidencePolicyRuntime;
}

const writeConfirmation = {
  idempotencyKey: "retry-1",
  confirmed: true,
};

describe("MCP source-call contract coverage", () => {
  it("exposes every listing evidence policy contract through its owning runtime", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;
    const common = { ...writeConfirmation, confirmationText: "Validate Listing Evidence Policy Draft." };

    await handlers["marketplace.get-listing-evidence-policy-overview"]!(input({}));
    await handlers["marketplace.get-listing-evidence-policy-selectors"]!(input({}));
    await handlers["marketplace.create-listing-evidence-policy-draft"]!(
      input({
        policyName: "Policy",
        rules: [],
        ...writeConfirmation,
        confirmationText: "Create Listing Evidence Policy Draft.",
      }),
    );
    await handlers["marketplace.validate-listing-evidence-policy-draft"]!(input({ policyId: "pol_draft", ...common }));
    await handlers["marketplace.reject-listing-evidence-policy-draft"]!(
      input({ policyId: "pol_draft", ...writeConfirmation, confirmationText: "Reject Listing Evidence Policy Draft." }),
    );
    await handlers["marketplace.create-listing-evidence-policy-rollback-draft"]!(
      input({
        policyId: "pol_active",
        ...writeConfirmation,
        confirmationText: "Create Listing Evidence Policy Rollback Draft.",
      }),
    );
    await handlers["marketplace.activate-listing-evidence-policy-draft"]!(
      input({
        policyId: "pol_draft",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        impactAcknowledgmentHash: "sha256:impact",
        ...writeConfirmation,
        confirmationText: "sha256:impact",
      }),
    );

    expect(runtime.getOverview).toHaveBeenCalledTimes(1);
    expect(runtime.loadSelectorCatalog).toHaveBeenCalledTimes(1);
    expect(runtime.createDraft).toHaveBeenCalledTimes(1);
    expect(runtime.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "usr_operator" }),
      expect.objectContaining({ audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" } }),
    );
    expect(runtime.validateDraft).toHaveBeenCalledWith("pol_draft", "usr_operator", expect.anything());
    expect(runtime.rejectDraft).toHaveBeenCalledWith("pol_draft", "usr_operator", expect.anything());
    expect(runtime.createRollbackDraft).toHaveBeenCalledWith("pol_active", "usr_operator", expect.anything());
    expect(runtime.activateDraft).toHaveBeenCalledWith(
      "pol_draft",
      expect.objectContaining({ actorUserId: "usr_operator", impactAcknowledgmentHash: "sha256:impact" }),
      expect.anything(),
    );
    expect(Object.keys(handlers).sort()).toEqual([
      "marketplace.activate-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-rollback-draft",
      "marketplace.get-listing-evidence-policy-overview",
      "marketplace.get-listing-evidence-policy-selectors",
      "marketplace.reject-listing-evidence-policy-draft",
      "marketplace.validate-listing-evidence-policy-draft",
    ]);
  });

  it("rejects omitted target input, account overrides, and missing operator actors before effects", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;

    await expect(
      handlers["marketplace.validate-listing-evidence-policy-draft"]!(
        input({ confirmationText: "Validate Listing Evidence Policy Draft.", idempotencyKey: "k", confirmed: true }),
      ),
    ).rejects.toThrow("policyId is required");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!(input({ accountId: "acc_other" })),
    ).rejects.toThrow("Unknown Listing Evidence Policy argument");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!({ ...input({}), actor: null }),
    ).rejects.toThrow("authenticated operator actor");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!({
        ...input({}),
        actor: { ...actor!, permissions: [] },
      }),
    ).rejects.toThrow("listing-evidence-policy.view");
    expect(runtime.validateDraft).not.toHaveBeenCalled();
    expect(runtime.getOverview).not.toHaveBeenCalled();
  });

  it("rejects unconfirmed and invalid rule writes before invoking the runtime", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;

    await expect(
      handlers["marketplace.create-listing-evidence-policy-draft"]!(
        input({
          policyName: "Policy",
          rules: [],
          idempotencyKey: "k",
          confirmationText: "Create Listing Evidence Policy Draft.",
        }),
      ),
    ).rejects.toThrow("confirmed must be true");
    await expect(
      handlers["marketplace.create-listing-evidence-policy-draft"]!(
        input({
          policyName: "Policy",
          rules: {},
          ...writeConfirmation,
          confirmationText: "Create Listing Evidence Policy Draft.",
        }),
      ),
    ).rejects.toThrow("rules must be a list");
    expect(runtime.createDraft).not.toHaveBeenCalled();
  });
});
