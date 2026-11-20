import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { hasInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import {
  inventoryMutationFingerprint,
  normalizeInventoryMutationIntent,
} from "../../../support/runtime-support/mutation-intent";
import { parseResolveRowBody, inventoryImportBatchRoutes } from "../api/route";
import type { InventoryImportBatchServices } from "../api/runtime";
import {
  ImportRowResolveConflict,
  importRowResolveConflictCodes,
  isImportRowFingerprint,
  isImportRowVersion,
} from "../domain/row-resolve-conflict";

const attemptId = "7d3d2c8f-963e-4e4b-b6d9-9c5092403b07";
const version = "2026-11-01T08:00:00.123456Z";
const fingerprint = "native-csv|1|review:cat_active:loc_active";
const validBody = {
  catalogItemId: "cat_active",
  selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
  storageLocationId: "loc_active",
  expectedRowVersion: version,
  expectedRowFingerprint: fingerprint,
};
const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};

function app(resolveRow: InventoryImportBatchServices["resolveRow"]) {
  const hono = new Hono<InventoryApiEnv>();
  hono.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_synthetic", permissions: ["inventory.manage"] } as never);
    c.set("context", context);
    await next();
  });
  hono.route("/", inventoryImportBatchRoutes({ resolveRow } as unknown as InventoryImportBatchServices));
  return hono;
}

function post(
  resolveRow: InventoryImportBatchServices["resolveRow"],
  body: unknown,
  attempt: string | null = attemptId,
) {
  return app(resolveRow).request("/imb_synthetic/rows/imr_synthetic/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(attempt === null ? {} : { "Inventory-Mutation-Attempt": attempt }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("issue-7169-ac7 resolve route parser", () => {
  it("forwards exactly the caller's facts and the stable attempt", async () => {
    const resolveRow = vi.fn<InventoryImportBatchServices["resolveRow"]>(async () => ({}) as never);
    const response = await post(resolveRow, validBody);
    expect(response.status).toBe(200);
    expect(resolveRow).toHaveBeenCalledExactlyOnceWith(
      { batchId: "imb_synthetic", rowId: "imr_synthetic", accountId: "acc_synthetic", ...validBody },
      expect.objectContaining(context),
    );
    expect(hasInventoryMutationAttempt(resolveRow.mock.calls[0]![1])).toBe(true);
  });

  const { expectedRowVersion: _version, ...withoutVersion } = validBody;
  it.each([
    ["missing attempt header", validBody, null, "invalid_resolve_request"],
    ["malformed attempt header", validBody, "not-a-uuid", "invalid_resolve_request"],
    ["non-JSON body", "{", attemptId, "invalid_resolve_request"],
    ["array body", [validBody], attemptId, "invalid_resolve_request"],
    ["null body", null, attemptId, "invalid_resolve_request"],
    ["unknown top-level field", { ...validBody, note: "x" }, attemptId, "invalid_resolve_request"],
    ["rowVersion alias beside the fact", { ...validBody, rowVersion: version }, attemptId, "invalid_resolve_request"],
    [
      "rowVersion alias instead of the fact",
      { ...withoutVersion, rowVersion: version },
      attemptId,
      "invalid_resolve_request",
    ],
    ["rowFingerprint alias", { ...validBody, rowFingerprint: fingerprint }, attemptId, "invalid_resolve_request"],
    ["missing version key", withoutVersion, attemptId, "invalid_resolve_request"],
    [
      "nested unknown option field",
      { ...validBody, selectedOptions: [{ dimensionId: "condition", optionId: "near_mint", extra: true }] },
      attemptId,
      "invalid_resolve_request",
    ],
    ["option as string", { ...validBody, selectedOptions: "[]" }, attemptId, "invalid_resolve_request"],
    [
      "empty option id",
      { ...validBody, selectedOptions: [{ dimensionId: "condition", optionId: "" }] },
      attemptId,
      "invalid_resolve_request",
    ],
    ["numeric catalog item", { ...validBody, catalogItemId: 7 }, attemptId, "invalid_resolve_request"],
    ["numeric version", { ...validBody, expectedRowVersion: 1793520000123 }, attemptId, "invalid_row_facts"],
    ["date-only version", { ...validBody, expectedRowVersion: "2026-11-01" }, attemptId, "invalid_row_facts"],
    [
      "timezone-offset version",
      { ...validBody, expectedRowVersion: "2026-11-01T08:00:00.123456+00:00" },
      attemptId,
      "invalid_row_facts",
    ],
    [
      "PostgreSQL text version",
      { ...validBody, expectedRowVersion: "2026-11-01 08:00:00.123456+00" },
      attemptId,
      "invalid_row_facts",
    ],
    [
      "millisecond ISO version",
      { ...validBody, expectedRowVersion: "2026-11-01T08:00:00.123Z" },
      attemptId,
      "invalid_row_facts",
    ],
    ["nested version", { ...validBody, expectedRowVersion: { value: version } }, attemptId, "invalid_row_facts"],
    ["numeric fingerprint", { ...validBody, expectedRowFingerprint: 1 }, attemptId, "invalid_row_facts"],
    ["empty version", { ...validBody, expectedRowVersion: "" }, attemptId, "missing_row_facts"],
    ["empty fingerprint", { ...validBody, expectedRowFingerprint: "" }, attemptId, "missing_row_facts"],
  ] as const)("refuses %s with a bounded 400 and never calls the authority", async (_case, body, attempt, code) => {
    const resolveRow = vi.fn<InventoryImportBatchServices["resolveRow"]>();
    const response = await post(resolveRow, body, attempt);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe(code);
    expect(payload.error.message).not.toContain(String(version));
    expect(resolveRow).not.toHaveBeenCalled();
  });

  it("parses the closed body directly", () => {
    expect(parseResolveRowBody({ ...validBody, catalogItemId: " cat_active " })).toEqual({
      ok: true,
      body: validBody,
    });
    expect(parseResolveRowBody({ ...validBody, expectedRowVersion: ` ${version}` })).toEqual({
      ok: false,
      code: "invalid_row_facts",
    });
  });
});

describe("issue-7169-ac7 resolve diagnostics", () => {
  it.each(importRowResolveConflictCodes)("maps %s to its bounded code and fixed message", async (code) => {
    const response = await post(
      vi.fn<InventoryImportBatchServices["resolveRow"]>(async () => {
        throw new ImportRowResolveConflict(code);
      }),
      validBody,
    );
    expect(response.status).toBe(code === "invalid_row_facts" || code === "missing_row_facts" ? 400 : 409);
    expect(await response.json()).toEqual({ error: { code, message: new ImportRowResolveConflict(code).message } });
  });

  it("never echoes a driver error and keeps Inventory validation text", async () => {
    const driver = await post(
      vi.fn<InventoryImportBatchServices["resolveRow"]>(async () => {
        throw new Error('invalid input syntax for type timestamp with time zone: "secret-payload"');
      }),
      validBody,
    );
    expect(driver.status).toBe(400);
    const driverPayload = (await driver.json()) as { error: { code: string; message: string } };
    expect(driverPayload.error.code).toBe("validation_failed");
    expect(driverPayload.error.message).not.toContain("secret-payload");

    const domain = await post(
      vi.fn<InventoryImportBatchServices["resolveRow"]>(async () => {
        throw new InventoryDomainError("Import row fix is incomplete: Storage location was not found.");
      }),
      validBody,
    );
    expect(await domain.json()).toEqual({
      error: { code: "validation_failed", message: "Import row fix is incomplete: Storage location was not found." },
    });
  });
});

describe("issue-7169-ac7 import-resolve-row intent", () => {
  const intent = {
    accountId: "acc_synthetic",
    batchId: "imb_synthetic",
    rowId: "imr_synthetic",
    expectedRowVersion: version,
    expectedRowFingerprint: fingerprint,
    catalogItemId: "cat_active",
    selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
    storageLocationId: "loc_active",
  };

  it("keeps caller facts verbatim and distinguishes intents by them", () => {
    const normalized = normalizeInventoryMutationIntent("import-resolve-row", intent);
    expect(normalized).toMatchObject({ expectedRowVersion: version, expectedRowFingerprint: fingerprint });
    expect(inventoryMutationFingerprint(normalized)).not.toBe(
      inventoryMutationFingerprint(
        normalizeInventoryMutationIntent("import-resolve-row", {
          ...intent,
          expectedRowVersion: "2026-11-01T08:00:00.123457Z",
        }),
      ),
    );
  });

  it.each([
    ["missing version", { ...intent, expectedRowVersion: undefined }, "Invalid import row version."],
    ["null fingerprint", { ...intent, expectedRowFingerprint: null }, "Invalid import row fingerprint."],
    ["numeric version", { ...intent, expectedRowVersion: 1 }, "Invalid import row version."],
    ["unknown field", { ...intent, rowVersion: version }, "Unknown Inventory mutation field: rowVersion."],
  ])("refuses %s", (_case, value, message) => {
    expect(() => normalizeInventoryMutationIntent("import-resolve-row", value)).toThrow(message);
  });
});

describe("issue-7169-ac7 row fact shapes", () => {
  it.each([
    [version, true],
    ["2026-11-01T08:00:00.000000Z", true],
    ["2026-11-01", false],
    ["2026-11-01T08:00:00Z", false],
    ["2026-11-01T08:00:00.123Z", false],
    ["2026-11-01T08:00:00.1234567Z", false],
    ["2026-11-01T08:00:00.123456+00:00", false],
    ["2026-11-01 08:00:00.123456+00", false],
    ["2026-13-01T08:00:00.123456Z", false],
    [1793520000123, false],
    [null, false],
  ])("row version %s -> %s", (value, accepted) => {
    expect(isImportRowVersion(value)).toBe(accepted);
  });

  it.each([
    [fingerprint, true],
    ["x", true],
    ["", false],
    ["fp\n", false],
    ["fp\u007f", false],
    ["f".repeat(2048), true],
    ["f".repeat(2049), false],
    [1, false],
  ])("row fingerprint %s -> %s", (value, accepted) => {
    expect(isImportRowFingerprint(value)).toBe(accepted);
  });
});
