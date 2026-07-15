import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { InventoryApiEnv } from "../../../api";
import { inventoryRecoveredItemRoutes } from "./route";
import type { RecoveredItemServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_platform" as never },
};

function appWithPermissions(permissions: readonly string[], services: Record<string, unknown>) {
  const app = new Hono<InventoryApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_platform", permissions });
    c.set("context", context);
    await next();
  });
  app.route("/", inventoryRecoveredItemRoutes(services as unknown as RecoveredItemServices));
  return app;
}

describe("recovered item routes", () => {
  it("redacts custody evidence unless the operator has the evidence permission", async () => {
    const list = vi.fn(async () => ({
      items: [
        {
          recovered_item_id: "rcv_1",
          evidence_references: ["att_private"],
          disposition_authority: { legalOwner: "platform" },
        },
      ],
      total: 1,
    }));
    const services = { list };

    const redacted = await appWithPermissions(["recovered-inventory.view"], services).request("/");
    const visible = await appWithPermissions(
      ["recovered-inventory.view", "recovered-inventory.evidence"],
      services,
    ).request("/");

    expect(await redacted.json()).toMatchObject({
      items: [{ evidence_references: [], disposition_authority: null }],
    });
    expect(await visible.json()).toMatchObject({
      items: [{ evidence_references: ["att_private"], disposition_authority: { legalOwner: "platform" } }],
    });
  });

  it("records operator identity and evidence on disposition commands", async () => {
    const execute = vi.fn(async () => ({ recoveredItemId: "rcv_1", version: 7, state: { status: "disposed" } }));
    const response = await appWithPermissions(["recovered-inventory.manage"], { execute }).request("/rcv_1/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "decide-disposition",
        disposition: "donation",
        policyVersion: "returns-2026-07",
        evidenceReferences: ["att_donation"],
        reasonCode: "approved-donation",
        occurredAt: "2026-07-15T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      "rcv_1",
      expect.objectContaining({
        type: "DecideRecoveredItemDisposition",
        decidedByUserId: "usr_operator",
        evidenceReferences: ["att_donation"],
      }),
      context,
    );
  });
});
