import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSettlementPayoutReadinessMcpHandlers } from "./mcp";
import type { PayoutReadinessServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["payouts.setup", "payouts.view"],
} satisfies ResolvedActor;

const protocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol,
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "acc_1",
    status: "pending",
    missing_requirements: ["provider-onboarding"],
    provider_reference: "acct_1",
    contact_email: "seller@example.test",
    onboarding_status: "pending",
    transfer_capability_status: "pending",
    payout_capability_status: "pending",
    payout_destination_status: "missing",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function services(): PayoutReadinessServices {
  return {
    refreshProviderReadiness: vi.fn(async (params) => readiness({ account_id: params.accountId })),
    createHostedPayoutSetupLink: vi.fn(async (params) => ({
      accountId: params.accountId,
      providerReference: "acct_1",
      url: "https://connect.stripe.test/setup/acct_1",
      expiresAt: null,
      readiness: readiness({ account_id: params.accountId }),
    })),
  } as unknown as PayoutReadinessServices;
}

describe("settlement payout readiness MCP handlers", () => {
  it("refreshes payout readiness through Settlement and returns a receipt", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutReadinessMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["settlement.refresh-readiness"]?.(
      mcpRequest({
        accountId: "acc_1",
        providerReference: "acct_1",
        contactEmail: "seller@example.test",
        idempotencyKey: "idem_refresh_1",
      }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "acc_1",
      status: "pending",
      readiness: { provider_reference: "acct_1" },
      resourceUri: "chase-sets://settlement/acc_1/wallet",
    });
    expect(fakeServices.refreshProviderReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        providerReference: "acct_1",
        contactEmail: "seller@example.test",
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("creates hosted payout onboarding links without returning provider secrets", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutReadinessMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["settlement.create-payout-onboarding-link"]?.(
      mcpRequest({
        accountId: "acc_1",
        returnUrl: "https://app.test/account/payouts/setup/return",
        refreshUrl: "https://app.test/account/payouts/setup/refresh",
        contactEmail: "seller@example.test",
        idempotencyKey: "idem_link_1",
      }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "acct_1",
      providerReference: "acct_1",
      status: "pending",
      url: "https://connect.stripe.test/setup/acct_1",
    });
    expect(result).not.toHaveProperty("clientSecret");
    expect(fakeServices.createHostedPayoutSetupLink).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        returnUrl: "https://app.test/account/payouts/setup/return",
        refreshUrl: "https://app.test/account/payouts/setup/refresh",
        idempotencyKey: "idem_link_1",
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("rejects non-HTTPS hosted link return targets", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutReadinessMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["settlement.create-payout-onboarding-link"]?.(
        mcpRequest({
          accountId: "acc_1",
          returnUrl: "http://app.test/account/payouts/setup/return",
          refreshUrl: "https://app.test/account/payouts/setup/refresh",
          idempotencyKey: "idem_link_1",
        }),
      ),
    ).rejects.toThrow("returnUrl must be an absolute HTTPS URL.");
    expect(fakeServices.createHostedPayoutSetupLink).not.toHaveBeenCalled();
  });
});
