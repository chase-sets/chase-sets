import { describe, expect, it } from "vitest";
import { foldEvents } from "@chase-sets/event-core";
import { accountLinkageFactTypes } from "@chase-sets/event-core/account-linkage-facts";
import {
  accountLinkageStreamId,
  decideAccountLinkage,
  evolveAccountLinkage,
  initialAccountLinkageState,
} from "./account-linkage";

const clusterHash = "a".repeat(64);
const firstFlag = {
  type: "FlagAccountLinkage" as const,
  clusterHash,
  signalKind: "shared-instrument" as const,
  accountIds: ["acc_b", "acc_a"],
};

describe("Account Linkage aggregate", () => {
  it("flags a canonical member set without source material", () => {
    expect(decideAccountLinkage(initialAccountLinkageState, firstFlag)).toEqual([
      {
        type: accountLinkageFactTypes.flagged,
        data: { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
      },
    ]);
  });

  it("no-ops an identical set regardless of command ordering and republishes a changed set", () => {
    const state = foldEvents(
      initialAccountLinkageState,
      evolveAccountLinkage,
      decideAccountLinkage(initialAccountLinkageState, firstFlag),
    );

    expect(decideAccountLinkage(state, { ...firstFlag, accountIds: ["acc_a", "acc_b"] })).toEqual([]);
    expect(decideAccountLinkage(state, { ...firstFlag, accountIds: ["acc_c", "acc_a", "acc_b"] })).toEqual([
      expect.objectContaining({
        type: accountLinkageFactTypes.flagged,
        data: expect.objectContaining({ accountIds: ["acc_a", "acc_b", "acc_c"] }),
      }),
    ]);
  });

  it("clears once, then permits the closer to re-raise the same still-shared cluster", () => {
    const flagged = foldEvents(
      initialAccountLinkageState,
      evolveAccountLinkage,
      decideAccountLinkage(initialAccountLinkageState, firstFlag),
    );
    const clearEvents = decideAccountLinkage(flagged, { type: "ClearAccountLinkage", clusterHash });
    expect(clearEvents).toEqual([
      {
        type: accountLinkageFactTypes.cleared,
        data: { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
      },
    ]);

    const cleared = foldEvents(flagged, evolveAccountLinkage, clearEvents);
    expect(decideAccountLinkage(cleared, { type: "ClearAccountLinkage", clusterHash })).toEqual([]);
    expect(decideAccountLinkage(cleared, firstFlag)).toHaveLength(1);
  });

  it("rejects semantic reuse of a stream for another signal or cluster", () => {
    const state = foldEvents(
      initialAccountLinkageState,
      evolveAccountLinkage,
      decideAccountLinkage(initialAccountLinkageState, firstFlag),
    );
    expect(() => decideAccountLinkage(state, { ...firstFlag, signalKind: "shared-address" })).toThrow("signal kind");
    expect(() => decideAccountLinkage(state, { type: "ClearAccountLinkage", clusterHash: "b".repeat(64) })).toThrow(
      "clusterHash",
    );
  });

  it("uses only the opaque hash in the stream id", () => {
    expect(accountLinkageStreamId(clusterHash)).toBe(`settlement.account-linkage-${clusterHash}`);
  });
});
