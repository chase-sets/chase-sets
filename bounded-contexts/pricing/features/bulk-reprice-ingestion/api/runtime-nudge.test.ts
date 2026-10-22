import { afterEach, describe, expect, it, vi } from "vitest";
import { BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { createBulkRepriceIngestionRuntime } from "./runtime";

afterEach(() => vi.useRealTimers());

describe("bulk migration nudge reliance before the optional sample floor", () => {
  it.each([
    [false, undefined, "reliance-not-met"],
    [false, 1, "reliance-not-met"],
    [true, undefined, "insufficient-estimates"],
  ] as const)("evaluates reliance=%s with sample floor=%s", async (reliant, floor, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const seller = {
      accountId: "acc_nudge_seller",
      bulkShare: reliant ? 1 : 0,
      bulkListingCount: reliant ? 6 : 0,
      bulkCount: reliant ? 6 : 0,
      policyCount: 0,
      manualCount: reliant ? 0 : 3,
    };
    const document = (value: unknown) => ({
      rows: [{ document_id: "synthetic-policy", value, effective_from: "2026-01-01", effective_until: null }],
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        document({
          ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
          enabled: true,
          ...(floor === undefined ? {} : { nudgeMinEstimateSamples: floor }),
        }),
      )
      .mockResolvedValueOnce(
        document({ maxBulkSharePercent: 10, consecutiveCompleteWeeks: 1, relianceListingThreshold: 5 }),
      )
      .mockResolvedValueOnce({
        rows: [
          {
            week_start: "2026-10-12",
            event_count: String(seller.bulkCount + seller.manualCount),
            bulk: String(seller.bulkCount),
            policy: "0",
            manual: String(seller.manualCount),
            unattributed: "0",
            max_reliant_bulk_listing_count: String(seller.bulkListingCount),
            top_sellers: [seller],
            requested_seller: seller,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ last_global_position: "3", global_position: "3", recorded_at: new Date("2026-10-19T00:00:00Z") }],
      });
    const runtime = createBulkRepriceIngestionRuntime({ db: { query } });

    expect(await runtime.getMigrationNudge(seller.accountId)).toEqual({
      status: "unavailable",
      offsetPercent: null,
      currencyCode: null,
      reason,
    });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[2]?.[1]?.[1]).toBe(seller.accountId);
  });
});
