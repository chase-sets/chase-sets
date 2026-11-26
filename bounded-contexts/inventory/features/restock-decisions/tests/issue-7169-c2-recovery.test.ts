import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildInventoryApi, type InventoryApiEnv } from "../../../api";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import {
  inventoryMutationFingerprint,
  normalizeInventoryMutationIntent,
} from "../../../support/runtime-support/mutation-intent";

const choice = {
  accountId: "acc_c2_synthetic",
  decisionId: "rstk_c2_synthetic",
  expectedVersion: 1,
  outcome: "written-off",
  damageNote: " Damaged packaging ",
};
const context: EventStoreContext = {
  tenantId: "tnt_c2_synthetic",
  audit: { performedByUserId: "usr_c2_synthetic", forAccountId: "acc_c2_synthetic" },
};
const id = "053210b9-1a0d-41b7-b95f-f13a4f2053bc";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("issue-7169-c2-route-isolation: versioned restock intent", () => {
  it("normalizes choice and note without changing the expected decision version", () => {
    const normalized = normalizeInventoryMutationIntent("restock-record", choice);
    expect(normalized).toEqual({ ...choice, damageNote: "Damaged packaging" });
    expect(inventoryMutationFingerprint(normalized)).toBe(
      inventoryMutationFingerprint(
        normalizeInventoryMutationIntent("restock-record", { ...choice, damageNote: "Damaged packaging" }),
      ),
    );
    for (const changed of [
      { ...choice, outcome: "restocked" },
      { ...choice, damageNote: "Different" },
      { ...choice, expectedVersion: 2 },
    ]) {
      expect(inventoryMutationFingerprint(normalizeInventoryMutationIntent("restock-record", changed))).not.toBe(
        inventoryMutationFingerprint(normalized),
      );
    }
  });

  it("treats absent, null and blank optional notes as the same normalized choice", () => {
    const { damageNote: _note, ...withoutNote } = choice;
    const normalized = normalizeInventoryMutationIntent("restock-record", withoutNote);
    expect(normalized).toEqual({ ...withoutNote, damageNote: null });
    for (const damageNote of [null, "", "  "]) {
      expect(normalizeInventoryMutationIntent("restock-record", { ...withoutNote, damageNote })).toEqual(normalized);
    }
  });

  it.each([
    { expectedVersion: undefined },
    { expectedVersion: 0 },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: "1" },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { outcome: "unknown" },
    { damageNote: {} },
    { unknown: true },
  ])("rejects malformed intent before accepting an attempt: %j", (invalid) => {
    expect(() => normalizeInventoryMutationIntent("restock-record", { ...choice, ...invalid })).toThrow();
  });
});

describe("issue-7169-c2-route-isolation: AC2/9/10/11/13 real router and action", () => {
  function router(mismatch = false) {
    const query = vi.fn(async () => {
      throw new Error("Synthetic persistence must not execute in a boundary probe.");
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const services = createInventoryServices(pool);
    const record = vi
      .spyOn(services.restockDecisions, "recordDecision")
      .mockResolvedValue({ decisionId: choice.decisionId, version: 2 });
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: choice.accountId, permissions: ["inventory.manage", "inventory.view"] });
      c.set(
        "context",
        mismatch ? { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } } : context,
      );
      await next();
    });
    app.route("/api/inventory", buildInventoryApi(services));
    return { app, record, query };
  }
  it("binds the exact caller attempt, trusted actor/account and expected decision version", async () => {
    const { app, record } = router();
    const response = await app.request(`/api/inventory/restock-decisions/${choice.decisionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Inventory-Mutation-Attempt": id },
      body: JSON.stringify({ expectedVersion: 1, outcome: "written-off", damageNote: "Damaged" }),
    });
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      { ...choice, damageNote: "Damaged" },
      withInventoryMutationAttempt(context, id),
    );
  });
  it.each([
    ["missing attempt", { expectedVersion: 1, outcome: "restocked" }, ""],
    ["business identity", { expectedVersion: 1, outcome: "restocked" }, "rstk_c2_synthetic"],
    ["missing version", { outcome: "restocked" }, id],
    ["numeric string version", { expectedVersion: "1", outcome: "restocked" }, id],
    ["unknown root", { expectedVersion: 1, outcome: "restocked", unknown: true }, id],
    ["payload authority", { expectedVersion: 1, outcome: "restocked", accountId: "acc_foreign_synthetic" }, id],
    ["nested note", { expectedVersion: 1, outcome: "restocked", damageNote: { unknown: true } }, id],
  ])("refuses %s before calling the owner", async (_name, body, attempt) => {
    const { app, record, query } = router();
    const response = await app.request(`/api/inventory/restock-decisions/${choice.decisionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Inventory-Mutation-Attempt": attempt },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." },
    });
    expect(record).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses an actor/account switch before calling the owner", async () => {
    const { app, record, query } = router(true);
    const response = await app.request(`/api/inventory/restock-decisions/${choice.decisionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Inventory-Mutation-Attempt": id },
      body: JSON.stringify({ expectedVersion: 1, outcome: "restocked" }),
    });
    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
