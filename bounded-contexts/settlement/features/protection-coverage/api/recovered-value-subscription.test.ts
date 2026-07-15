import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as settlementModule } from "../../../index";
import type { SettlementServices } from "../../../support/runtime-support/services";

describe("settlement recovered value subscription", () => {
  it("attributes Inventory gross and cost to the originating settled coverage", async () => {
    const recordRecovery = vi.fn(async () => ({ outcome: "applied", coverageId: "cov_1" }));
    const services = {
      protectionCoverage: { recordRecovery },
      db: {
        query: vi.fn(async () => ({
          rows: [{ coverage_id: "cov_1", remedy_id: "rmd_1", currency_code: "usd", status: "settled" }],
        })),
      },
      projectors: [],
    } as unknown as SettlementServices;
    const subscription = (settlementModule.buildSubscriptions?.(services) ?? []).find(
      (candidate) => candidate.subscriptionName === "settlement.inventory-recovery-workflow",
    );
    expect(subscription).toBeDefined();
    await subscription!.handlers["inventory.recovered-item.value-reported.v1"]!(
      buildTransportEvent(
        "inventory.recovered-item.value-reported.v1",
        {
          factSchemaVersion: 1,
          recoveredItemId: "rcv_1",
          returnShipmentId: "rsh_1",
          remedyId: "rmd_1",
          recoveryId: "recovery-1",
          recoveryType: "liquidation-proceeds",
          grossAmount: "50.00",
          costAmount: "8.00",
          currencyCode: "USD",
          policyVersion: "returns-2026-07",
          evidenceReferences: ["liquidation-receipt-1"],
          recordedAt: "2026-07-15T02:00:00.000Z",
        },
        {
          id: "evt_value_1",
          tenantId: "tnt_1",
          streamId: "inventory.recovered-item-rcv_1",
          streamVersion: 6,
          globalPosition: "6",
          audit: { performedByUserId: "usr_operator", forAccountId: null },
          trace: { traceId: "trace_1" },
          timing: { occurredAt: "2026-07-15T02:00:00.000Z", recordedAt: "2026-07-15T02:00:00.000Z" },
        },
      ),
    );

    expect(recordRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageId: "cov_1",
        recoveryId: "recovery-1",
        grossAmount: "50.00",
        costAmount: "8.00",
        causationId: "evt_value_1",
      }),
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
  });
});
