import { describe, expect, it } from "vitest";
import {
  accountLinkageFactTypes,
  normalizeAccountLinkageClearedPayload,
  normalizeAccountLinkageFlaggedPayload,
} from "./account-linkage-facts";

const clusterHash = "a".repeat(64);

describe("account-linkage facts", () => {
  it("pins the ratified event names", () => {
    expect(accountLinkageFactTypes).toEqual({
      flagged: "settlement.account-linkage.flagged",
      cleared: "settlement.account-linkage.cleared",
    });
  });

  it("canonicalizes the linked account set and strips non-contract source fields", () => {
    expect(
      normalizeAccountLinkageFlaggedPayload({
        clusterHash,
        signalKind: "shared-instrument",
        accountIds: ["acc_b", "acc_a", "acc_b"],
        instrument_cluster_key: "must-not-cross-boundary",
      }),
    ).toEqual({
      clusterHash,
      signalKind: "shared-instrument",
      accountIds: ["acc_a", "acc_b"],
    });
  });

  it("rejects malformed hashes, signal kinds, and singleton clusters", () => {
    expect(() =>
      normalizeAccountLinkageFlaggedPayload({ clusterHash: "raw-key", signalKind: "shared-address", accountIds: [] }),
    ).toThrow("64-character");
    expect(() =>
      normalizeAccountLinkageFlaggedPayload({ clusterHash, signalKind: "device", accountIds: ["acc_a", "acc_b"] }),
    ).toThrow("signalKind");
    expect(() =>
      normalizeAccountLinkageFlaggedPayload({ clusterHash, signalKind: "shared-address", accountIds: ["acc_a"] }),
    ).toThrow("at least two");
  });

  it("keeps a clear self-describing without leaking source material", () => {
    expect(
      normalizeAccountLinkageClearedPayload({
        clusterHash,
        signalKind: "shared-address",
        accountIds: ["acc_b", "acc_a"],
        address_cluster_key: "private",
      }),
    ).toEqual({
      clusterHash,
      signalKind: "shared-address",
      accountIds: ["acc_a", "acc_b"],
    });
  });
});
