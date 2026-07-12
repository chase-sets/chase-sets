import type { ActionFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { action } from "./account-agents-detail";

const { mockCreateUcpOAuthRequestApiClient } = vi.hoisted(() => ({
  mockCreateUcpOAuthRequestApiClient: vi.fn(),
}));

vi.mock("../../support/request-support/api-client", () => ({
  createUcpOAuthRequestApiClient: mockCreateUcpOAuthRequestApiClient,
}));

function createActionArgs(request: Request, params: ActionFunctionArgs["params"]): ActionFunctionArgs {
  return {
    request,
    params,
    context: {},
    url: new URL(request.url),
    pattern: "/account/agents/:id",
  };
}

describe("connected-agent detail action", () => {
  it("revokes the grant and redirects back to the detail page", async () => {
    const revokeAgentGrant = vi.fn(async () => ({ revoked: true }));
    mockCreateUcpOAuthRequestApiClient.mockReturnValue({
      revokeAgentGrant,
      updateAgentGrantMandate: vi.fn(),
    });

    const request = new Request("http://localhost/account/agents/lpa_1", {
      method: "POST",
      body: new URLSearchParams({ intent: "revoke" }),
    });
    const response = (await action(createActionArgs(request, { id: "lpa_1" }))) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/agents/lpa_1");
    expect(revokeAgentGrant).toHaveBeenCalledWith("lpa_1");
  });

  it("converts decimal-string caps to cents, treats blank fields as no cap, and defaults empty rails to handoff-only", async () => {
    const updateAgentGrantMandate = vi.fn(async () => ({ spending_mandate: {} }));
    mockCreateUcpOAuthRequestApiClient.mockReturnValue({
      revokeAgentGrant: vi.fn(),
      updateAgentGrantMandate,
    });

    const request = new Request("http://localhost/account/agents/lpa_1", {
      method: "POST",
      body: new URLSearchParams({
        intent: "update-mandate",
        max_per_order_amount: "40.00",
        daily_cap_amount: "50",
        monthly_cap_amount: "",
        human_present_required: "false",
      }),
    });
    const response = (await action(createActionArgs(request, { id: "lpa_1" }))) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/agents/lpa_1");
    expect(updateAgentGrantMandate).toHaveBeenCalledWith("lpa_1", {
      max_per_order_cents: 4_000,
      daily_cap_cents: 5_000,
      monthly_cap_cents: null,
      human_present_required: false,
      allowed_rails: ["handoff-only"],
    });
  });

  it("passes through explicitly selected rails and defaults human_present_required to true when omitted", async () => {
    const updateAgentGrantMandate = vi.fn(async () => ({ spending_mandate: {} }));
    mockCreateUcpOAuthRequestApiClient.mockReturnValue({
      revokeAgentGrant: vi.fn(),
      updateAgentGrantMandate,
    });

    const formData = new URLSearchParams();
    formData.append("intent", "update-mandate");
    formData.append("allowed_rails", "stored-pm");
    formData.append("allowed_rails", "ap2");
    const request = new Request("http://localhost/account/agents/lpa_1", {
      method: "POST",
      body: formData,
    });
    await action(createActionArgs(request, { id: "lpa_1" }));

    expect(updateAgentGrantMandate).toHaveBeenCalledWith("lpa_1", {
      max_per_order_cents: null,
      daily_cap_cents: null,
      monthly_cap_cents: null,
      human_present_required: true,
      allowed_rails: ["stored-pm", "ap2"],
    });
  });
});
