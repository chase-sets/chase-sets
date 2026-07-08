import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSettlementPayoutMcpHandlers } from "./mcp";
import type { PayoutServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["payouts.view", "payouts.request"],
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

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    payout_id: "pyo_1",
    account_id: "acc_1",
    amount: "25.00",
    currency_code: "usd",
    destination_reference: null,
    note: "Requested by agent",
    status: "in-transit",
    provider_transfer_reference: "tr_1",
    provider_payout_reference: "po_1",
    provider_status: "pending",
    provider_failure_code: null,
    provider_failure_message: null,
    requested_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    sent_at: "2026-07-08T00:00:00.000Z",
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    last_provider_event_at: null,
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

function services(): PayoutServices {
  return {
    listPayouts: vi.fn(async () => ({ items: [payoutRow()], total: 1 })),
    getPayout: vi.fn(async (payoutId, accountId) => payoutRow({ payout_id: payoutId, account_id: accountId })),
    requestPayout: vi.fn(async (params) => ({
      payoutId: "pyo_1" as never,
      version: 3,
      payout: payoutRow({ account_id: params.accountId, amount: params.amount }),
    })),
  } as unknown as PayoutServices;
}

describe("settlement payout MCP handlers", () => {
  it("lists and reads account payouts by natural key", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutMcpHandlers(fakeServices);

    const list = await handlers.toolHandlers["settlement.list-payouts"]?.(
      mcpRequest({ accountId: "acc_1", limit: 10, offset: 5 }),
    );
    const get = await handlers.toolHandlers["settlement.get-payout"]?.(
      mcpRequest({ accountId: "acc_1", payoutId: "pyo_1" }),
    );

    expect(list).toMatchObject({ accountId: "acc_1", total: 1, count: 1 });
    expect(get).toMatchObject({ accountId: "acc_1", payout: { payout_id: "pyo_1" } });
    expect(fakeServices.listPayouts).toHaveBeenCalledWith({ accountId: "acc_1", limit: 10, offset: 5 });
    expect(fakeServices.getPayout).toHaveBeenCalledWith("pyo_1", "acc_1");
  });

  it("requests payouts through Settlement and returns an MCP write receipt", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["settlement.request-payout"]?.(
      mcpRequest({
        accountId: "acc_1",
        amount: "25.00",
        reason: "Agent requested payout.",
        idempotencyKey: "idem_1",
      }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "pyo_1",
      payoutId: "pyo_1",
      version: 3,
      status: "in-transit",
      resourceUri: "chase-sets://settlement/acc_1/payouts/pyo_1",
    });
    expect(fakeServices.requestPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        amount: "25.00",
        note: "Agent requested payout.",
        actorUserId: "usr_1",
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("rejects account mismatches before requesting payouts", async () => {
    const fakeServices = services();
    const handlers = createSettlementPayoutMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["settlement.request-payout"]?.(
        mcpRequest({ accountId: "acc_other", amount: "25.00", reason: "Wrong account" }),
      ),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.requestPayout).not.toHaveBeenCalled();
  });

  it("reads payout resources by URI", async () => {
    const handlers = createSettlementPayoutMcpHandlers(services());

    const result = await handlers.resourceHandlers["chase-sets://settlement/{accountId}/payouts/{payoutId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://settlement/acc_1/payouts/pyo_1",
      request: new Request("https://api.test/mcp"),
      protocol,
    });

    expect(result).toMatchObject({ payout_id: "pyo_1", account_id: "acc_1" });
  });
});
