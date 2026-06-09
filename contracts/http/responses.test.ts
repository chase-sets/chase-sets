import { describe, expect, it } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  appendFreshWriteToken,
  appendFreshWriteTokenFromSources,
  attachResponseMetadata,
  classifyFreshWriteReadError,
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

  it("classifies fresh-write not-found and projection freshness timeouts as transient", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);

    expect(
      classifyFreshWriteReadError({
        request: href,
        error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "transient-not-found",
      transient: true,
      status: 404,
      errorCode: "not_found",
    });

    expect(
      classifyFreshWriteReadError({
        request: href,
        error: {
          status: 503,
          body: {
            error: {
              code: "projection_freshness_timeout",
              message: "Projection read model did not catch up before the freshness timeout.",
            },
          },
        },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "transient-projection-timeout",
      transient: true,
      status: 503,
      errorCode: "projection_freshness_timeout",
    });
  });

  it("classifies manual, malformed, and expired not-found reads as permanent", () => {
    expect(
      classifyFreshWriteReadError({
        request: "/checkout/chk_1",
        error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "permanent-not-found",
      transient: false,
      receipt: null,
    });

    expect(
      classifyFreshWriteReadError({
        request: "/checkout/chk_1?afterWrite=%7Bnot-json",
        error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "permanent-not-found",
      transient: false,
      receipt: null,
    });

    const expiredHref = appendFreshWriteToken(
      "/checkout/chk_1",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      1,
    );
    expect(
      classifyFreshWriteReadError({
        request: expiredHref,
        error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
        nowMs: 40_000,
      }),
    ).toMatchObject({
      kind: "permanent-not-found",
      transient: false,
      receipt: null,
    });
  });

  it("does not classify unrelated fresh-write errors as transient", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);

    expect(
      classifyFreshWriteReadError({
        request: href,
        error: { status: 503, body: { error: { code: "provider_failed", message: "Provider failed." } } },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "fresh-write-unhandled",
      transient: false,
      status: 503,
      errorCode: "provider_failed",
    });
  });
});
