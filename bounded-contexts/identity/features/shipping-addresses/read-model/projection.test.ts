import type { TransportEvent } from "@chase-sets/event-core";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { buildShippingAddressProjectionHandlers } from "./projection";

type RecordedQuery = Readonly<{
  sql: string;
  values: readonly unknown[];
}>;

function createRecordingDb(): PgQueryable & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
}

function shippingAddressEvent(
  type: string,
  data: Readonly<Record<string, unknown>>,
  recordedAt = "2026-07-03T12:00:00.000Z",
): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type}`,
    streamId: "identity.shipping-address-book-acc_1",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

const address = {
  name: "Alex Collector",
  company: null,
  line1: "100 Main St",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
};

describe("shipping address projection", () => {
  it("scopes update and archive row mutations to the event account", async () => {
    const db = createRecordingDb();
    const handlers = buildShippingAddressProjectionHandlers(db);

    await handlers["identity.shipping-address.updated"]?.(
      shippingAddressEvent("identity.shipping-address.updated", {
        accountId: "acc_1",
        shippingAddressId: "adr_1",
        label: "Home",
        address,
        isDefault: false,
        updatedAt: "2026-07-03T12:01:00.000Z",
      }),
    );
    await handlers["identity.shipping-address.archived"]?.(
      shippingAddressEvent("identity.shipping-address.archived", {
        accountId: "acc_1",
        shippingAddressId: "adr_1",
        promotedDefaultShippingAddressId: null,
        archivedAt: "2026-07-03T12:02:00.000Z",
      }),
    );

    expect(db.queries[0]?.sql).toContain("AND account_id = $16");
    expect(db.queries[0]?.values[15]).toBe("acc_1");
    expect(db.queries[1]?.sql).toContain("AND account_id = $3");
    expect(db.queries[1]?.values[2]).toBe("acc_1");
  });
});
