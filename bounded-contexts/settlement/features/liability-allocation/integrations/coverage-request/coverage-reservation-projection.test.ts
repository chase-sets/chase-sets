import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { ProtectionCoverageSettlementPort } from "../../api/ports";
import { buildSettlementCoverageReservationHandlers } from "./coverage-reservation-projection";

function transportEvent(data: Record<string, unknown>) {
  return buildTransportEvent("support.support-request.platform-coverage-requested.v1", data, {
    id: "evt_req",
    streamId: "platform-operations.support-request-sup_1",
    streamVersion: 2,
    globalPosition: "1",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
    trace: {},
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  });
}

describe("settlement coverage reservation projection", () => {
  it("reserves the requested platform-funded amount against the ProtectionCoverage aggregate", async () => {
    const reserve = vi.fn(async (_input: Record<string, unknown>, _context?: unknown) => ({
      outcome: "reserved" as const,
      coverageId: "cov_1",
      currencyCode: "usd",
      reservedAmount: "40.00",
      rejectionReason: null,
    }));
    const protectionCoverage = {
      reserve,
      settle: vi.fn(),
      getCoverage: vi.fn(),
    } as unknown as ProtectionCoverageSettlementPort;
    const handlers = buildSettlementCoverageReservationHandlers(protectionCoverage);

    await handlers["support.support-request.platform-coverage-requested.v1"]!(
      transportEvent({
        factSchemaVersion: 1,
        supportRequestId: "sup_1",
        remedyId: "rmd_1",
        idempotencyKey: "coverage-request:cov_1",
        causationId: null,
        policyVersion: "coverage-policy-2026-07",
        occurredAt: "2026-05-01T00:00:00.000Z",
        coverageId: "cov_1",
        requestedAmount: "40.00",
        currencyCode: "usd",
        reasonCode: "fault-indeterminate",
      }),
    );

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]![0]).toMatchObject({
      coverageId: "cov_1",
      remedyId: "rmd_1",
      supportRequestId: "sup_1",
      requestedAmount: "40.00",
      currencyCode: "usd",
      policyVersion: "coverage-policy-2026-07",
      idempotencyKey: "coverage-request:cov_1",
    });
  });
});
