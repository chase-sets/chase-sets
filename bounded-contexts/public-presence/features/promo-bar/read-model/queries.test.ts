import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPromoBarMessage } from "./queries";

function database() {
  const query = vi.fn(async (_text: string, values?: readonly unknown[]) => ({
    rows: [{ id: "pbm_1", starts_at: values?.[8] ?? null, ends_at: values?.[9] ?? null }],
    rowCount: 1,
  }));
  return { db: { query } as unknown as PgQueryable, query };
}

describe("promo bar schedule times", () => {
  it.each([
    ["2026-11-10T15:00:00.000Z", "2026-11-10T15:00:00.000Z"],
    ["2026-11-10T09:00:00-06:00", "2026-11-10T15:00:00.000Z"],
    ["2026-11-10 15:00:00+00", "2026-11-10T15:00:00.000Z"],
  ])("keeps %s, which says its zone", async (startsAt, stored) => {
    const { db, query } = database();
    await createPromoBarMessage(db, { title: "Fee holiday", startsAt });

    expect(query.mock.calls[0]![1]![8]).toBe(stored);
  });

  it("answers the stored start and end as ISO instants, not PostgreSQL's text form", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "pbm_1",
          starts_at: "2026-07-02 00:00:00+00",
          ends_at: "2026-07-02 05:30:00.123456-05",
          display_order: "1",
        },
      ],
      rowCount: 1,
    }));

    const message = await createPromoBarMessage({ query } as unknown as PgQueryable, { title: "Fee holiday" });

    expect(message).toMatchObject({ starts_at: "2026-07-02T00:00:00.000Z", ends_at: "2026-07-02T10:30:00.123Z" });
  });

  it.each(["2026-11-10T09:00", "2026-11-10 09:00:00", "next week"])(
    "refuses %s rather than read it in this server's zone",
    async (startsAt) => {
      const { db, query } = database();

      await expect(createPromoBarMessage(db, { title: "Fee holiday", startsAt })).rejects.toThrow(
        "Promo bar dates must be valid dates with a time zone.",
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
});
