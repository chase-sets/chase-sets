import { describe, expect, it, vi } from "vitest";
import { buildRepricingSourceShareProjectionHandlers, listRepricingSourceShareWeeks } from "./source-share";

describe("repricing source-share projection", () => {
  it.each([undefined, "invalid", "seller", "bulk-reprice", "repricing-engine"])(
    "records declared source %s with event-id dedupe",
    async (source) => {
      const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      await buildRepricingSourceShareProjectionHandlers(db as never)["marketplace.listing.price-updated"]!({
        id: "evt_1",
        streamId: "marketplace.listing-lst_1",
        data: { changeSource: source },
        audit: { forAccountId: "acc_1" },
        timing: { occurredAt: "2026-10-07T12:00:00Z", recordedAt: "2026-10-07T12:00:00Z" },
        globalPosition: "4",
      } as never);
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (event_id) DO NOTHING"), [
        "evt_1",
        "2026-10-05",
        "acc_1",
        "lst_1",
        source === undefined || source === "invalid" ? "unattributed" : source,
        "2026-10-07T12:00:00Z",
        "4",
      ]);
      expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("source_share_watermark"), [
        "4",
        "2026-10-07T12:00:00Z",
      ]);
    },
  );

  it("keeps a fresh processing time incomplete without an acknowledged source watermark", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              last_global_position: "9007199254740992",
              global_position: "9007199254740993",
              recorded_at: new Date("2026-10-12"),
            },
          ],
        }),
    };
    expect(
      (await listRepricingSourceShareWeeks(db as never, { from: "2026-10-05", to: "2026-10-05" }))[0],
    ).toMatchObject({ status: "incomplete", reason: "checkpoint-lag", eventCount: 0 });
  });

  it.each([
    ["2026-10-11T23:59:59Z", "2026-10-05"],
    ["2026-10-12T00:00:00Z", "2026-10-12"],
  ])("partitions %s into the canonical Monday-start week %s", async (occurredAt, weekStart) => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await buildRepricingSourceShareProjectionHandlers(db as never)["marketplace.listing.price-updated"]!({
      id: "boundary",
      streamId: "marketplace.listing-lst_1",
      globalPosition: "1",
      audit: { forAccountId: "seller" },
      data: { changeSource: "seller" },
      timing: { occurredAt, recordedAt: occurredAt },
    } as never);
    expect(db.query.mock.calls[0]?.[1]?.[1]).toBe(weekStart);
  });

  it.each([
    { from: "2026-01-01", to: "2026-10-01" },
    { from: "bad", to: "2026-10-01" },
    { from: "2026-10-01", to: "2026-01-01" },
    { from: "2026-10-06", to: "2026-10-05" },
    { from: "2026-02-30", to: "2026-03-01" },
  ])("rejects an invalid/unbounded range before querying: %s", async (range) => {
    const db = { query: vi.fn() };
    await expect(listRepricingSourceShareWeeks(db as never, range)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
});
