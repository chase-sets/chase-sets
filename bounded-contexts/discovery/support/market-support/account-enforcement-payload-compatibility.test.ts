import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";

describe("Discovery account enforcement payload compatibility", () => {
  it("projects every modern lifecycle fact without consuming enforcement data", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.includes("RETURNING outbox_id") ? [{ outbox_id: "1" }] : [],
    }));
    const handlers = buildDiscoveryMarketProjectionHandlers({ query } as never);

    for (const [type, status, reason] of [
      ["identity.account.suspended", "suspended", "policy-violation"],
      ["identity.account.reactivated", "active", "appeal-upheld"],
      ["identity.account.closed", "closed", "operator-other"],
    ] as const) {
      await handlers[type]!(
        buildTransportEvent(
          type,
          {
            enforcement: {
              version: 1,
              enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
              reason,
              reference: null,
            },
          },
          {
            streamId: "identity.account-acc_compat",
            globalPosition: "42",
            timing: {
              occurredAt: "2026-08-19T00:00:00.000Z",
              recordedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        ),
      );
      expect(
        query.mock.calls.some(
          ([sql, values]) =>
            String(sql).includes("discovery_market_accounts") &&
            (values as readonly unknown[] | undefined)?.includes(status),
        ),
      ).toBe(true);
    }
  });
});
