import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSettlementWalletMcpHandlers } from "./mcp";
import type { WalletServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["payouts.view"],
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

function walletRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "acc_1",
    currency_code: "usd",
    pending_balance_amount: "10.00",
    available_balance_amount: "25.00",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function ledgerEntry(overrides: Record<string, unknown> = {}) {
  return {
    ledger_entry_id: "led_1",
    account_id: "acc_1",
    kind: "sale-proceeds",
    direction: "credit",
    amount: "25.00",
    currency_code: "usd",
    funds_status: "available",
    order_id: null,
    payment_id: null,
    payout_id: null,
    description: "Sale proceeds",
    posted_at: "2026-07-08T00:00:00.000Z",
    available_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function services(): WalletServices {
  return {
    getWallet: vi.fn(async (accountId) => walletRow({ account_id: accountId })),
    listWalletEntries: vi.fn(async () => ({ items: [ledgerEntry()], total: 1 })),
  } as unknown as WalletServices;
}

describe("settlement wallet MCP handlers", () => {
  it("reads wallet balance and ledger entries", async () => {
    const fakeServices = services();
    const handlers = createSettlementWalletMcpHandlers(fakeServices);

    const wallet = await handlers.toolHandlers["settlement.get-wallet"]?.(mcpRequest({ accountId: "acc_1" }));
    const entries = await handlers.toolHandlers["settlement.list-ledger-entries"]?.(
      mcpRequest({ accountId: "acc_1", limit: 10, offset: 5 }),
    );

    expect(wallet).toMatchObject({ accountId: "acc_1", wallet: { available_balance_amount: "25.00" } });
    expect(entries).toMatchObject({ accountId: "acc_1", total: 1, count: 1 });
    expect(fakeServices.getWallet).toHaveBeenCalledWith("acc_1");
    expect(fakeServices.listWalletEntries).toHaveBeenCalledWith({ accountId: "acc_1", limit: 10, offset: 5 });
  });

  it("reads wallet resources by URI", async () => {
    const handlers = createSettlementWalletMcpHandlers(services());

    const result = await handlers.resourceHandlers["chase-sets://settlement/{accountId}/wallet"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://settlement/acc_1/wallet",
      request: new Request("https://api.test/mcp"),
      protocol,
    });

    expect(result).toMatchObject({ account_id: "acc_1", available_balance_amount: "25.00" });
  });
});
