import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
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
    enqueueCreateBatchJob: vi.fn<InventoryImportBatchServices["enqueueCreateBatchJob"]>(async (params, context) => ({
      jobId: "job_c3_synthetic",
      jobKind: "create",
      status: "queued",
      payload: {
        accountId: params.accountId,
        batchId: "imb_1",
        create: { inputId: "input_synthetic", batchId: "imb_1" },
      },
      progress: {
        phase: "queued",
        completed: 0,
        total: params.parsedRows?.length ?? 1,
        currentRowId: null,
        message: null,
      },
      result: null,
      errorMessage: null,
      eventContext: context,
      claimOwnerId: null,
      claimedUntil: null,
      attemptCount: 0,
      nextEligibleAt: "2026-10-16T00:00:00.000Z",
      createdAt: "2026-10-16T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-10-16T00:00:00.000Z",
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

function storageLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    storage_location_id: "loc_1",
    account_id: "acc_1",
    name: "Warehouse A",
    description: null,
    ship_from_code: "AUS",
    ship_from_address: {},
    is_archived: false,
    updated_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function storageLocations(
  locations: readonly Record<string, unknown>[] = [storageLocationRow()],
): Pick<StorageLocationServices, "listStorageLocations"> {
  return {
    listStorageLocations: vi.fn(async () => locations),
  } as unknown as Pick<StorageLocationServices, "listStorageLocations">;
}

describe("inventory import batch MCP handlers", () => {
  it("lists source profiles so agents can choose row semantics", async () => {
    const handlers = createInventoryImportBatchMcpHandlers(services(), storageLocations());
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
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices, storageLocations());

    const result = await handlers.toolHandlers["inventory.create-import-batch"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        sourceKey: "shopify-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_1",
        sourceFilename: "shopify-api-sync",
        idempotencyKey: "d56cccd7-29dd-4815-929a-d79c49a3b51f",
        parsedRows: [{ rowNumber: 1, values: { "Variant ID": "987", "Variant Inventory Qty": "2" } }],
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toEqual({ receiptVersion: 1, jobId: "job_c3_synthetic", batchId: "imb_1", status: "accepted" });
    expect("createBatch" in fakeServices).toBe(false);
    expect(fakeServices.enqueueCreateBatchJob).toHaveBeenCalledWith(
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

  it("resolves a defaultStorageLocationName to the canonical storage location id", async () => {
    const fakeServices = services();
    const fakeStorageLocations = storageLocations([
      storageLocationRow({ storage_location_id: "loc_9", name: "Back Room" }),
    ]);
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices, fakeStorageLocations);

    await handlers.toolHandlers["inventory.create-import-batch"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        sourceKey: "shopify-csv",
        quantityMode: "replace",
        defaultStorageLocationName: "back room",
        idempotencyKey: "d56cccd7-29dd-4815-929a-d79c49a3b51f",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(fakeStorageLocations.listStorageLocations).toHaveBeenCalledWith({
      accountId: "acc_1",
      includeArchived: false,
    });
    expect(fakeServices.enqueueCreateBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ defaultStorageLocationId: "loc_9" }),
      expect.anything(),
    );
  });

  it("rejects an ambiguous defaultStorageLocationName with a candidate list", async () => {
    const fakeServices = services();
    const fakeStorageLocations = storageLocations([
      storageLocationRow({ storage_location_id: "loc_1", name: "Warehouse" }),
      storageLocationRow({ storage_location_id: "loc_2", name: "Warehouse" }),
    ]);
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices, fakeStorageLocations);

    await expect(
      handlers.toolHandlers["inventory.create-import-batch"]?.({
        actor,
        tool: null as never,
        arguments: {
          accountId: "acc_1",
          sourceKey: "shopify-csv",
          quantityMode: "replace",
          defaultStorageLocationName: "Warehouse",
        },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow(/Multiple storage locations are named "Warehouse": loc_1 \(Warehouse\), loc_2 \(Warehouse\)/);
    expect(fakeServices.enqueueCreateBatchJob).not.toHaveBeenCalled();
  });

  it("rejects account id mismatches before calling Inventory", async () => {
    const fakeServices = services();
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices, storageLocations());

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

  it("returns a versioned durable commit acceptance rather than executing stock synchronously", async () => {
    const fake = services();
    const job = await fake.enqueueCreateBatchJob(
      { accountId: actor.accountId as AccountId, csvText: "a\n1" },
      {
        tenantId: actor.tenantId,
        audit: { forAccountId: actor.accountId, performedByUserId: actor.userId },
      },
    );
    const enqueueCommitBatchJob = vi.fn<InventoryImportBatchServices["enqueueCommitBatchJob"]>(async () => ({
      ...job,
      jobKind: "commit",
    }));
    const handlers = createInventoryImportBatchMcpHandlers({ ...fake, enqueueCommitBatchJob }, storageLocations());
    const result = await handlers.toolHandlers["inventory.commit-import-batch"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: actor.accountId, batchId: "imb_1" },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });
    expect(result).toEqual({ receiptVersion: 1, jobId: job.jobId, batchId: "imb_1", status: "accepted" });
    expect(enqueueCommitBatchJob).toHaveBeenCalledWith(
      { accountId: actor.accountId, batchId: "imb_1" },
      expect.objectContaining({ tenantId: actor.tenantId }),
    );
    expect(fake.commitBatch).not.toHaveBeenCalled();
  });

  it("rejects dry-run writes before mutating import state", async () => {
    const fakeServices = services();
    const handlers = createInventoryImportBatchMcpHandlers(fakeServices, storageLocations());

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
    expect(fakeServices.enqueueCreateBatchJob).not.toHaveBeenCalled();
  });

  it("reads import batch resources by URI", async () => {
    const handlers = createInventoryImportBatchMcpHandlers(services(), storageLocations());
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
