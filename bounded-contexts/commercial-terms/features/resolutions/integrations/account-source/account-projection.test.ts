import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildCommercialTermsAccountProjectionHandlers } from "./account-projection";

describe("Commercial Terms account enforcement payload compatibility", () => {
  it("keeps all modern Identity lifecycle payloads additive", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildCommercialTermsAccountProjectionHandlers({ query } as never);
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
            timing: {
              occurredAt: "2026-08-19T00:00:00.000Z",
              recordedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        ),
      );
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining(`status = '${status}'`), [
        "acc_compat",
        "2026-08-19T00:00:00.000Z",
      ]);
    }
  });
});
