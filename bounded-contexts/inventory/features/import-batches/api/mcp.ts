import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  readOptionalMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { listInventoryImportSourceProfiles } from "../domain/import-source-profiles";
import type { InventoryImportSourceKey } from "../domain/import-source-profiles";
import type { InventoryImportQuantityMode } from "../domain/import-source-adapters";
import type { ImportCsvRow } from "../domain/csv";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
import type { InventoryImportBatchServices } from "./runtime";

export type InventoryImportBatchMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type ParsedImportRowInput = Readonly<{
  rowNumber?: unknown;
  values?: unknown;
}>;

function parseQuantityMode(value: string | null): InventoryImportQuantityMode | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== "add" && value !== "replace") {
    throw new Error("quantityMode must be add or replace.");
  }

  return value;
}

function parseParsedRows(value: unknown): readonly ImportCsvRow[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("parsedRows must be an array.");
  }

  return value.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Each parsedRows entry must be an object.");
    }

    const record = row as ParsedImportRowInput;
    if (typeof record.values !== "object" || record.values === null || Array.isArray(record.values)) {
      throw new Error("Each parsedRows entry requires a values object.");
    }

    return {
      rowNumber: Number(record.rowNumber ?? index + 1),
      values: Object.fromEntries(Object.entries(record.values).map(([key, rawValue]) => [key, String(rawValue ?? "")])),
    };
  });
}

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for inventory import batch MCP writes yet.");
  }
}

/**
 * Mirrors `resolveStorageLocationId` in the inventory-items MCP handlers
 * (kept feature-local rather than shared, matching the existing convention of
 * small per-file argument helpers in this context). Storage location names
 * are not database-unique, so an ambiguous name throws a structured,
 * candidate-listing error rather than guessing.
 */
async function resolveDefaultStorageLocationId(
  storageLocations: Pick<StorageLocationServices, "listStorageLocations">,
  accountId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  const id = readOptionalMcpTypedIdArgument(args, "defaultStorageLocationId", "loc");
  if (id) {
    return id;
  }

  const name = readMcpStringArgument(args, "defaultStorageLocationName");
  if (!name) {
    return null;
  }

  // Archived locations cannot receive new stock, so a default-location name
  // resolves against active locations only.
  const locations = await storageLocations.listStorageLocations({ accountId, includeArchived: false });
  const normalizedName = name.trim().toLocaleLowerCase("en-US");
  const matches = locations.filter((location) => location.name.trim().toLocaleLowerCase("en-US") === normalizedName);

  if (matches.length === 0) {
    throw new Error(`No active storage location named "${name}" was found for this account.`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((location) => `${location.storage_location_id} (${location.name})`).join(", ");
    throw new Error(
      `Multiple storage locations are named "${name}": ${candidates}. Provide defaultStorageLocationId to disambiguate.`,
    );
  }

  return matches[0].storage_location_id;
}

function importBatchUriParts(uri: string): Readonly<{ accountId: string; batchId: string }> | null {
  const match = /^chase-sets:\/\/inventory\/([^/]+)\/import-batches\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    batchId: decodeURIComponent(match[2] ?? ""),
  };
}

export function createInventoryImportBatchMcpHandlers(
  services: InventoryImportBatchServices,
  storageLocations: Pick<StorageLocationServices, "listStorageLocations">,
): InventoryImportBatchMcpHandlers {
  const listImportSources: McpToolHandler = ({ actor, arguments: args }) => {
    ensureMcpActorAccount(actor, readMcpStringArgument(args, "accountId"));

    return {
      items: listInventoryImportSourceProfiles(),
      total: listInventoryImportSourceProfiles().length,
    };
  };

  const createImportBatch: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const detail = await services.createBatch(
      {
        accountId: scopedActor.accountId as AccountId,
        csvText: readMcpStringArgument(args, "csvText") ?? undefined,
        parsedRows: parseParsedRows(args.parsedRows),
        sourceKey: readMcpStringArgument(args, "sourceKey") as InventoryImportSourceKey | undefined,
        quantityMode: parseQuantityMode(readMcpStringArgument(args, "quantityMode")),
        defaultStorageLocationId: await resolveDefaultStorageLocationId(storageLocations, scopedActor.accountId, args),
        sourceFilename: readMcpStringArgument(args, "sourceFilename"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return detail;
  };

  const getImportBatch: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const batchId = readMcpTypedIdArgument(args, "batchId", "imb");

    const detail = await services.getBatch(batchId, scopedActor.accountId);
    if (!detail) {
      throw new Error("Import batch not found.");
    }

    return detail;
  };

  const commitImportBatch: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const batchId = readMcpTypedIdArgument(args, "batchId", "imb");

    return services.commitBatch(
      {
        accountId: scopedActor.accountId as AccountId,
        batchId,
      },
      createActorEventStoreContext(scopedActor),
    );
  };

  const readImportBatchResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = importBatchUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported inventory import batch resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const detail = await services.getBatch(parts.batchId, scopedActor.accountId);
    if (!detail) {
      throw new Error("Import batch not found.");
    }

    return detail;
  };

  return {
    toolHandlers: {
      "inventory.list-import-sources": listImportSources,
      "inventory.create-import-batch": createImportBatch,
      "inventory.get-import-batch": getImportBatch,
      "inventory.commit-import-batch": commitImportBatch,
    },
    resourceHandlers: {
      "chase-sets://inventory/{accountId}/import-batches/{batchId}": readImportBatchResource,
    },
  };
}
