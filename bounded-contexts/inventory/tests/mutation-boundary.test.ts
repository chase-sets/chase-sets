import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildInventoryApi, type InventoryApiEnv } from "../api";
import { createInventoryServices } from "../support/runtime-support/services";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

describe("issue-7169-c1-boundary-recovery: AC9/10/13 full router", () => {
  function router(permissions = ["inventory.manage", "inventory.view"], mismatch = false) {
    const query = vi.fn(async () => {
      throw new Error("No boundary rejection may touch persistence.");
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const services = createInventoryServices(pool);
    const read = vi.spyOn(services.mutations, "read").mockResolvedValue({
      version: 1,
      family: "hold-create",
      targetId: "draft",
      completedAt: "2026-10-13T00:00:00Z",
      result: { holdId: "hld_synthetic" },
    });
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_synthetic", permissions });
      c.set("context", {
        tenantId: "tnt_synthetic",
        audit: { performedByUserId: "usr_synthetic", forAccountId: mismatch ? "acc_foreign" : "acc_synthetic" },
      });
      await next();
    });
    app.route("/api/inventory", buildInventoryApi(services));
    return { app, query, read };
  }
  const body = {
    catalogItemId: "cat_synthetic",
    selectedOptions: [],
    storageLocationId: "loc_synthetic",
    totalQuantity: 1,
  };
  it.each([
    ["missing caller attempt", body, {}],
    [
      "payload account authority",
      { ...body, accountId: "acc_foreign" },
      { "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc" },
    ],
    [
      "recursive unknown",
      { ...body, selectedOptions: [{ dimensionId: "form", optionId: "raw", secret: "synthetic" }] },
      { "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc" },
    ],
  ])("refuses %s before querying or accepting", async (_name, input, headers) => {
    const { app, query } = router();
    const response = await app.request("/api/inventory/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." },
    });
    expect(query).not.toHaveBeenCalled();
  });
  describe("refuses client card and malformed cert", () => {
    const attempt = { "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc" };
    const graded = [
      { dimensionId: "form", optionId: "graded" },
      { dimensionId: "company", optionId: "psa" },
      { dimensionId: "grade", optionId: "ten" },
    ];
    const card = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: "cert-123",
      population: null,
      conditionDescriptors: [],
    };
    function post(input: Record<string, unknown>) {
      const { app, query } = router();
      return {
        query,
        response: app.request("/api/inventory/items", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...attempt },
          body: JSON.stringify(input),
        }),
      };
    }

    it.each([
      ["matching card", { ...body, selectedOptions: graded, gradedCard: card }],
      ["mismatching card", { ...body, selectedOptions: graded, gradedCard: { ...card, grade: "9" } }],
      ["card on a raw item", { ...body, gradedCard: card }],
      [
        "card beside a certification number",
        { ...body, selectedOptions: graded, certificationNumber: "cert-123", gradedCard: card },
      ],
      ["stale form card string", { ...body, selectedOptions: graded, gradedCard: JSON.stringify(card) }],
      ["null card", { ...body, gradedCard: null }],
      ["numeric certification number", { ...body, selectedOptions: graded, certificationNumber: 123 }],
      ["object certification number", { ...body, selectedOptions: graded, certificationNumber: { value: "cert-123" } }],
      ["array certification number", { ...body, selectedOptions: graded, certificationNumber: ["cert-123"] }],
      ["boolean certification number", { ...body, selectedOptions: graded, certificationNumber: false }],
    ])("refuses a %s before persistence", async (_name, input) => {
      const { query, response } = post(input);
      const refused = await response;
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." },
      });
      expect(query).not.toHaveBeenCalled();
    });

    it.each([
      ["string", { ...body, selectedOptions: graded, certificationNumber: "cert-123" }],
      ["null", { ...body, selectedOptions: graded, certificationNumber: null }],
      ["absent", body],
    ])("lets a %s certification number through to the create command", async (_name, input) => {
      const { query, response } = post(input);
      const accepted = await response;
      expect(accepted.status).not.toBe(400);
      expect(query).toHaveBeenCalled();
    });
  });

  it("refuses an actor/context mismatch without disclosure or mutation", async () => {
    const { app, query } = router(undefined, true);
    const response = await app.request("/api/inventory/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Inventory-Mutation-Attempt": "053210b9-1a0d-41b7-b95f-f13a4f2053bc",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["orders.manage", "guest-checkout.manage"])(
    "allows %s to read only their privately bound original result",
    async (permission) => {
      const { app, read } = router([permission]);
      const response = await app.request("/api/inventory/mutation-attempts/053210b9-1a0d-41b7-b95f-f13a4f2053bc");
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(read).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } }),
      );
      expect((await app.request("/api/inventory/items")).status).toBe(403);
    },
  );
});
