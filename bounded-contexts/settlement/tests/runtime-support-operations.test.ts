import { describe, expect, it } from "vitest";
import { settlementOperationLogFields } from "../support/runtime-support/operations";

describe("settlement operation log fields", () => {
  it("omits free-form reason text from structured operation logs", () => {
    expect(
      settlementOperationLogFields({
        kind: "payout-setup-session-failed",
        accountId: "acc_test",
        reason: "raw provider payload with client_secret and tax id",
        safeCategory: "provider_rate_limited",
      }),
    ).toEqual({
      kind: "payout-setup-session-failed",
      accountId: "acc_test",
      safeCategory: "provider_rate_limited",
    });
  });
});
