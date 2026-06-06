import { describe, expect, it } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  appendFreshWriteToken,
  appendFreshWriteTokenFromSources,
  attachResponseMetadata,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  getResponseMetadata,
  readFreshWriteToken,
  readResponseConsistencyMetadata,
} from "./responses";

const source = {
  sourceContextName: "marketplace",
  maxGlobalPosition: "42",
  eventIds: ["evt_1"],
};

const laterSource = {
  sourceContextName: "marketplace",
  maxGlobalPosition: "44",
  eventIds: ["evt_2"],
};

const checkoutSource = {
  sourceContextName: "checkout",
  maxGlobalPosition: "9",
  eventIds: ["evt_checkout"],
};

describe("response consistency metadata", () => {
  it("round-trips source-context commit receipts through headers and fresh-write tokens", () => {
    const headers = new Headers({
      "Chase-Sets-Consistency": "eventual",
      "Chase-Sets-Commit-Position": "42",
      "Chase-Sets-Commit-Event-Ids": "evt_1",
      [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([source]),
    });

    const metadata = readResponseConsistencyMetadata({ headers });
    expect(metadata?.commitPositions).toEqual([source]);

    const body = attachResponseMetadata({ id: "lst_1" }, { headers });
    expect(getResponseMetadata(body)?.consistency?.commitPositions).toEqual([source]);

    const href = appendFreshWriteToken("/account/listings/lst_1", body, 1234);
    expect(readFreshWriteToken(href, 1234)).toEqual({
      observedAtMs: 1234,
      commitPosition: "42",
      sources: [source],
    });
  });

  it("rejects expired read-after-write receipts", () => {
    const href = appendFreshWriteToken("/account/listings/lst_1", { commitPositions: [source], commitEventIds: [] }, 1);

    expect(readFreshWriteToken(href, 40_000)).toBeNull();
    expect(decodeFreshWriteReceipt("%7Bnot-json", 1)).toBeNull();
  });

  it("combines multiple write sources into one fresh-write token", () => {
    const first = {
      commitPosition: "42",
      commitPositions: [source, checkoutSource],
      commitEventIds: ["evt_1", "evt_checkout"],
    };
    const second = {
      commitPosition: "44",
      commitPositions: [laterSource],
      commitEventIds: ["evt_2"],
    };

    const href = appendFreshWriteTokenFromSources("/checkout/chk_1?paymentMethodCategory=card", [first, second], 1234);

    expect(readFreshWriteToken(href, 1234)).toEqual({
      observedAtMs: 1234,
      commitPosition: "44",
      sources: [
        checkoutSource,
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "44",
          eventIds: ["evt_1", "evt_2"],
        },
      ],
    });
  });

  it("leaves paths unchanged when write sources have no consistency metadata", () => {
    expect(
      appendFreshWriteTokenFromSources("/checkout/chk_1?paymentMethodCategory=card", [{ status: "ok" }], 1234),
    ).toBe("/checkout/chk_1?paymentMethodCategory=card");
  });
});
