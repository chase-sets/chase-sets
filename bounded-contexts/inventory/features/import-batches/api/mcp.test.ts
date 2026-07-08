import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createInventoryImportBatchMcpHandlers } from "./mcp";
import type { InventoryImportBatchServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["inventory.view", "inventory.manage"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function services(): InventoryImportBatchServices {
  return {
    createBatch: vi.fn(async (params) => ({
      batch_id: "imb_1",
      account_id: params.accountId,
      status: "uploaded",
      source_key: "shopify-csv",
      adapter_version: 1,
      quantity_mode: params.quantityMode ?? "replace",
      default_storage_location_id: params.defaultStorageLocationId ?? null,
      source_filename: params.sourceFilename ?? null,
      total_count: params.parsedRows?.length ?? 1,
      accepted_count: 1,
      rejected_count: 0,
      committed_count: 0,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      rows: [],
    })),
    getBatch: vi.fn(async (batchId, accountId) => ({
      batch_id: batchId,
      account_id: accountId,
      status: "uploaded",
      source_key: "shopify-csv",
      adapter_version: 1,
      quantity_mode: "replace",
      default_storage_location_id: "loc_1",
      source_filename: "shopify.csv",
      total_count: 1,
      accepted_count: 1,
      rejected_count: 0,
      committed_count: 0,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      rows: [],
    })),
    listBatches: vi.fn(async () => ({ items: [], total: 0 })),
    commitBatch: vi.fn(async (params) => ({
      batch_id: params.batchId,
      account_id: params.accountId,
      status: "committed",
      source_key: "shopify-csv",
      adapter_version: 1,
      quantity_mode: "replace",
      default_storage_location_id: "loc_1",
      source_filename: "shopify.csv",
      total_count: 1,
      accepted_count: 1,
      rejected_count: 0,
      committed_count: 1,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      rows: [],
    })),
  } as unknown as InventoryImportBatchServices;
}

describe("inventory import batch MCP handlers", () => {
  it("lists source profiles so agents can choose row semantics", async () => {
    const handlers = createInventoryImportBatchMcpHandlers(services());
    const result = await handlers.toolHandlers["inventory.list-import-sources"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1" },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      total: expect.any(Number),
      items: expect.arrayContaining([expect.objectContaining({ sourceKey: "shopify-csv" })]),
    });
  });

  it("creates batches from parsed provider rows and preserves actor context", async () => {
    const fakeServices = services();
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["inventory.create-import-batch"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        sourceKey: "shopify-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_1",
        sourceFilename: "shopify-api-sync",
        parsedRows: [{ rowNumber: 1, values: { "Variant ID": "987", "Variant Inventory Qty": 2 } }],
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ batch_id: "imb_1", total_count: 1 });
    expect(fakeServices.createBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1" as AccountId,
        parsedRows: [{ rowNumber: 1, values: { "Variant ID": "987", "Variant Inventory Qty": "2" } }],
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("rejects account id mismatches before calling Inventory", async () => {
    const fakeServices = services();
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["inventory.commit-import-batch"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other", batchId: "imb_1" },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.commitBatch).not.toHaveBeenCalled();
  });

  it("rejects dry-run writes before mutating import state", async () => {
    const fakeServices = services();
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["inventory.create-import-batch"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          sourceKey: "shopify-csv",
          quantityMode: "replace",
          dryRun: true,
        },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("dryRun is not supported for inventory import batch MCP writes yet.");
    expect(fakeServices.createBatch).not.toHaveBeenCalled();
  });

  it("reads import batch resources by URI", async () => {
    const handlers = createInventoryImportBatchMcpHandlers(services());
    const result = await handlers.resourceHandlers["chase-sets://inventory/{accountId}/import-batches/{batchId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://inventory/acc_1/import-batches/imb_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      batch_id: "imb_1",
      account_id: "acc_1",
    });
  });
});
