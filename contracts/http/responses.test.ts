import { describe, expect, it } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  appendFreshWriteToken,
  appendFreshWriteTokenFromSources,
  appendPostWriteHandoff,
  appendPostWriteHandoffFromSources,
  attachResponseMetadata,
  classifyFreshWriteReadError,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  evaluatePostWriteHandoff,
  getMutationResultCommandReceipt,
  getResponseMetadata,
  isBoundedTemporaryPostWriteRecoveryKind,
  loadAfterWrite,
  navigateAfterWrite,
  navigateAfterWriteFromSources,
  postWriteRecoveryKindForFreshWriteReadError,
  postWriteRecoveryKindForHandoffState,
  readFreshWriteToken,
  readFreshWriteTokenState,
  readPostWriteHandoff,
  readPostWriteHandoffState,
  readResponseConsistencyMetadata,
  recoverFreshWriteReadError,
} from "./responses";
import {
  semanticHandoffFixtureAddLine,
  semanticHandoffFixtureCartStates,
  semanticHandoffFixtureDetailStates,
  semanticHandoffFixtureUrls,
} from "./semantic-handoff-test-fixtures";

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
    expect(getMutationResultCommandReceipt(body)?.commitPositions).toEqual([source]);

    const href = appendFreshWriteToken("/account/listings/lst_1", body, 1234);
    expect(readFreshWriteToken(href, 1234)).toEqual({
      observedAtMs: 1234,
      commitPosition: "42",
      sources: [source],
    });
  });

  it("exposes command receipts as a typed non-enumerable mutation result contract", () => {
    const headers = new Headers({
      "Chase-Sets-Consistency": "eventual",
      [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([checkoutSource]),
    });

    const body = attachResponseMetadata({ status: "accepted", visibleField: "kept" }, { headers });

    expect(getMutationResultCommandReceipt(body)).toEqual({
      mode: "eventual",
      commitEventIds: [],
      commitPositions: [checkoutSource],
    });
    expect(Object.keys(body).sort()).toEqual(["status", "visibleField"]);
    expect(JSON.stringify(body)).toBe('{"status":"accepted","visibleField":"kept"}');
    expect(getMutationResultCommandReceipt(body)).not.toHaveProperty("accountId");
    expect(getMutationResultCommandReceipt(body)).not.toHaveProperty("email");
    expect(getMutationResultCommandReceipt(body)).not.toHaveProperty("paymentId");
  });

  it("accepts an explicit command receipt when callers construct typed mutation results", () => {
    const result = {
      status: "accepted",
      commandReceipt: {
        mode: "eventual",
        commitEventIds: ["evt_checkout"],
        commitPositions: [checkoutSource],
      },
    };

    expect(getMutationResultCommandReceipt(result)).toBe(result.commandReceipt);
    expect(readFreshWriteToken(appendFreshWriteToken("/account/cart", result, 1234), 1234)).toEqual({
      observedAtMs: 1234,
      sources: [checkoutSource],
    });
  });

  it("keeps hidden response metadata backward compatible for existing callers", () => {
    const hiddenOnly = {};
    Object.defineProperty(hiddenOnly, Symbol.for("@chase-sets/http.response-metadata"), {
      value: {
        consistency: {
          mode: "eventual",
          commitEventIds: [],
          commitPositions: [checkoutSource],
        },
      },
      enumerable: false,
    });

    expect(getMutationResultCommandReceipt(hiddenOnly)).toBeNull();
    expect(readFreshWriteToken(appendFreshWriteToken("/account/cart", hiddenOnly, 1234), 1234)).toEqual({
      observedAtMs: 1234,
      sources: [checkoutSource],
    });
  });

  it("distinguishes missing, malformed, and no-op command receipts without fresh-write redirects", () => {
    const missing = attachResponseMetadata({ status: "accepted" }, { headers: new Headers() });
    const malformed = attachResponseMetadata(
      { status: "accepted" },
      {
        headers: new Headers({
          "Chase-Sets-Consistency": "eventual",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: "%7Bnot-json",
        }),
      },
    );
    const noOp = attachResponseMetadata(
      { status: "accepted" },
      { headers: new Headers({ "Chase-Sets-Consistency": "eventual" }) },
    );

    expect(getMutationResultCommandReceipt(missing)).toBeNull();
    expect(getMutationResultCommandReceipt(malformed)).toEqual({
      mode: "eventual",
      commitEventIds: [],
      commitPositions: [],
    });
    expect(getMutationResultCommandReceipt(noOp)).toEqual({
      mode: "eventual",
      commitEventIds: [],
      commitPositions: [],
    });
    expect(appendFreshWriteTokenFromSources("/checkout/chk_1", [missing, malformed, noOp], 1234)).toBe(
      "/checkout/chk_1",
    );
  });

  it("combines multiple typed mutation result command receipts into one fresh-write token", () => {
    const first = attachResponseMetadata(
      { status: "accepted" },
      {
        headers: new Headers({
          "Chase-Sets-Consistency": "eventual",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([source, checkoutSource]),
        }),
      },
    );
    const second = attachResponseMetadata(
      { status: "accepted" },
      {
        headers: new Headers({
          "Chase-Sets-Consistency": "eventual",
          "Chase-Sets-Commit-Position": "44",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([laterSource]),
        }),
      },
    );

    const href = appendFreshWriteTokenFromSources("/checkout/chk_1", [first, second], 1234);

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

  it("rejects expired read-after-write receipts", () => {
    const href = appendFreshWriteToken("/account/listings/lst_1", { commitPositions: [source], commitEventIds: [] }, 1);

    expect(readFreshWriteToken(href, 40_000)).toBeNull();
    expect(readFreshWriteTokenState(href, 40_000)).toMatchObject({
      kind: "expired",
      observedAtMs: 1,
      ageMs: 39_999,
      maxAgeMs: 30_000,
    });
    expect(decodeFreshWriteReceipt("%7Bnot-json", 1)).toBeNull();
    expect(readFreshWriteTokenState("/checkout/chk_1?afterWrite=%7Bnot-json", 1)).toEqual({
      kind: "malformed",
      receipt: null,
    });
  });

  it("keeps delayed navigation and reload reuse valid within the token lifetime", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);

    expect(readFreshWriteTokenState(href, 29_999)).toMatchObject({
      kind: "valid",
      ageMs: 29_998,
    });
    expect(readFreshWriteToken(href, 29_999)).toEqual(readFreshWriteToken(href, 29_999));
  });

  it("allows small clock skew but rejects far-future tokens", () => {
    const href = appendFreshWriteToken(
      "/checkout/chk_1",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      10_000,
    );

    expect(readFreshWriteTokenState(href, 6_000)).toMatchObject({
      kind: "valid",
      ageMs: -4_000,
    });
    expect(readFreshWriteTokenState(href, 4_000)).toMatchObject({
      kind: "future",
      observedAtMs: 10_000,
      ageMs: -6_000,
      clockSkewMs: 5_000,
    });
    expect(readFreshWriteToken(href, 4_000)).toBeNull();
  });

  it("keeps fresh-write tokens limited to commit receipt metadata", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);
    const token = new URL(href, "https://chase-sets.local").searchParams.get("afterWrite");
    const parsed = JSON.parse(decodeURIComponent(String(token))) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(["observedAtMs", "sources"]);
    expect(parsed).not.toHaveProperty("accountId");
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("sessionId");
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

  it("carries semantic post-write handoff metadata only with a fresh-write receipt", () => {
    const href = appendPostWriteHandoff(
      "/account/cart?view=full",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      {
        kind: "checkout.cart.add-line",
        expectation: "collection-non-empty",
        surface: "account-cart",
      },
      1234,
    );

    expect(href).toContain("afterWrite=");
    expect(href).toContain("postWriteHandoff=");
    expect(readPostWriteHandoff(href, 1234)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
    expect(readPostWriteHandoffState(href, 1234)).toMatchObject({
      kind: "valid",
      ageMs: 0,
      receipt: {
        sources: [checkoutSource],
      },
    });

    expect(
      appendPostWriteHandoff(
        "/account/cart",
        { status: "accepted" },
        {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
        },
        1234,
      ),
    ).toBe("/account/cart");
  });

  it("combines multiple command receipts for semantic post-write handoffs", () => {
    const href = appendPostWriteHandoffFromSources(
      "/account/listings/lst_1",
      [
        { commitPositions: [source], commitEventIds: ["evt_1"] },
        { commitPosition: "44", commitPositions: [laterSource], commitEventIds: ["evt_2"] },
      ],
      {
        kind: "marketplace.listing.publish",
        expectation: "resource-updated",
        surface: "account-listing",
      },
      1234,
    );

    expect(readFreshWriteToken(href, 1234)).toMatchObject({
      commitPosition: "44",
      sources: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "44",
          eventIds: ["evt_1", "evt_2"],
        },
      ],
    });
    expect(readPostWriteHandoff(href, 1234)).toEqual({
      kind: "marketplace.listing.publish",
      expectation: "resource-updated",
      surface: "account-listing",
    });
  });

  it("rejects sensitive or arbitrary semantic handoff fields", () => {
    expect(() =>
      appendPostWriteHandoff(
        "/account/cart",
        { commitPositions: [checkoutSource], commitEventIds: [] },
        {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          email: "buyer@example.com",
        } as never,
        1234,
      ),
    ).toThrow("safe semantic fields");

    expect(() =>
      appendPostWriteHandoff(
        "/account/cart",
        { commitPositions: [checkoutSource], commitEventIds: [] },
        {
          kind: "checkout cart add line",
          expectation: "collection-non-empty",
        },
        1234,
      ),
    ).toThrow("safe semantic fields");

    expect(() =>
      appendPostWriteHandoff(
        "/account/listings/lst_1",
        { commitPositions: [source], commitEventIds: [] },
        {
          kind: "marketplace.listing.publish",
          expectation: "resource-updated",
          surface: "account-listing",
          resource: { id: "lst_1" },
        } as never,
        1234,
      ),
    ).toThrow("safe semantic fields");
  });

  it("does not treat handoff metadata as valid without a valid fresh-write receipt", () => {
    const href = appendPostWriteHandoff(
      "/account/cart",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      {
        kind: "checkout.cart.add-line",
        expectation: "collection-non-empty",
      },
      1,
    );

    expect(readPostWriteHandoffState(href, 40_000)).toMatchObject({
      kind: "not-fresh-write",
      handoff: {
        kind: "checkout.cart.add-line",
      },
      freshWrite: {
        kind: "expired",
      },
    });
    expect(readPostWriteHandoff(href, 40_000)).toBeNull();
    expect(readPostWriteHandoffState("/account/cart?postWriteHandoff=%7Bnot-json", 1)).toEqual({
      kind: "malformed",
      handoff: null,
      freshWrite: { kind: "missing", receipt: null },
    });
  });

  it("lets destination routes evaluate semantic handoff satisfaction with local predicates", () => {
    const href = appendPostWriteHandoff(
      "/account/cart",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      {
        kind: "checkout.cart.add-line",
        expectation: "collection-non-empty",
      },
      1234,
    );

    expect(
      evaluatePostWriteHandoff({
        request: href,
        data: { items: [], count: 0 },
        nowMs: 1234,
        isSatisfied: (cart, handoff) => handoff.expectation === "collection-non-empty" && cart.items.length > 0,
      }),
    ).toMatchObject({
      kind: "pending",
      handoff: { kind: "checkout.cart.add-line" },
    });

    expect(
      evaluatePostWriteHandoff({
        request: href,
        data: { items: [{ id: "line_1" }], count: 1 },
        nowMs: 1234,
        isSatisfied: (cart, handoff) => handoff.expectation === "collection-non-empty" && cart.items.length > 0,
      }),
    ).toMatchObject({
      kind: "satisfied",
      handoff: { kind: "checkout.cart.add-line" },
    });

    expect(
      evaluatePostWriteHandoff({
        request: "/account/cart",
        data: { items: [], count: 0 },
        nowMs: 1234,
        isSatisfied: () => false,
      }),
    ).toMatchObject({
      kind: "not-applicable",
      state: { kind: "missing" },
    });
  });

  it("builds default-safe post-write destinations without leaking command details", () => {
    const href = navigateAfterWrite(
      {
        commitPositions: [source],
        commitEventIds: ["evt_1"],
        email: "seller@example.com",
      },
      "/account/listings/lst_1?feedbackWorkflow=listing-publish",
      {
        nowMs: 1234,
        handoff: {
          kind: "marketplace.listing.publish",
          expectation: "resource-updated",
          surface: "account-listing",
        },
      },
    );

    expect(readFreshWriteToken(href, 1234)).toEqual({
      observedAtMs: 1234,
      sources: [source],
    });
    expect(readPostWriteHandoff(href, 1234)).toEqual({
      kind: "marketplace.listing.publish",
      expectation: "resource-updated",
      surface: "account-listing",
    });

    const token = new URL(href, "https://chase-sets.local").searchParams.get("afterWrite");
    const parsed = JSON.parse(decodeURIComponent(String(token))) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("email");
    expect(href).toContain("feedbackWorkflow=listing-publish");
  });

  it("combines multiple command receipts through the default-safe source primitive", () => {
    const href = navigateAfterWriteFromSources(
      [
        { commitPositions: [source], commitEventIds: ["evt_1"] },
        { commitPositions: [checkoutSource], commitEventIds: ["evt_checkout"] },
      ],
      "/checkout/chk_1",
      { nowMs: 1234 },
    );

    expect(readFreshWriteToken(href, 1234)).toEqual({
      observedAtMs: 1234,
      sources: [checkoutSource, source],
    });
    expect(readPostWriteHandoff(href, 1234)).toBeNull();
  });

  it("returns typed data or semantic pending results for default-safe destination reads", async () => {
    const href = navigateAfterWrite(
      { commitPositions: [checkoutSource], commitEventIds: [] },
      "/account/cart",
      {
        nowMs: 1234,
        handoff: {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          surface: "account-cart",
        },
      },
    );
    const request = new Request(`https://marketplace.chasesets.test${href}`);
    const isHandoffSatisfied = (cart: { items: readonly unknown[] }, handoff: { expectation: string }) =>
      handoff.expectation === "collection-non-empty" && cart.items.length > 0;

    await expect(
      loadAfterWrite({
        request,
        load: async () => ({ items: [], count: 0 }),
        isNotFound: () => false,
        isHandoffSatisfied,
        nowMs: () => 1234,
      }),
    ).resolves.toMatchObject({
      kind: "pending",
      reason: "semantic-handoff-pending",
      recoveryKind: "pending-projection",
      data: { items: [], count: 0 },
      handoff: { handoff: { kind: "checkout.cart.add-line" } },
    });

    await expect(
      loadAfterWrite({
        request,
        load: async () => ({ items: [{ id: "line_1" }], count: 1 }),
        isNotFound: () => false,
        isHandoffSatisfied,
        nowMs: () => 1234,
      }),
    ).resolves.toMatchObject({
      kind: "data",
      data: { items: [{ id: "line_1" }], count: 1 },
      handoff: { kind: "satisfied" },
    });
  });

  it("returns typed pending and permanent failures for default-safe destination read errors", async () => {
    const href = navigateAfterWrite(
      { commitPositions: [checkoutSource], commitEventIds: [] },
      "/checkout/chk_1",
      { nowMs: 1 },
    );
    const notFoundError = { status: 404, body: { error: { code: "not_found", message: "Not found." } } };

    await expect(
      loadAfterWrite({
        request: new Request(`https://marketplace.chasesets.test${href}`),
        load: async () => {
          throw notFoundError;
        },
        isNotFound: () => true,
        retryDelaysMs: [],
        nowMs: () => 1,
      }),
    ).resolves.toMatchObject({
      kind: "pending",
      reason: "fresh-write-read-transient",
      recoveryKind: "refreshable-catching-up",
      classification: { kind: "transient-not-found" },
    });

    await expect(
      loadAfterWrite({
        request: new Request("https://marketplace.chasesets.test/checkout/chk_1"),
        load: async () => {
          throw notFoundError;
        },
        isNotFound: () => true,
        retryDelaysMs: [],
        nowMs: () => 1,
      }),
    ).resolves.toMatchObject({
      kind: "permanent-failure",
      reason: "fresh-write-read-permanent",
      recoveryKind: "terminal-failure",
      classification: { kind: "permanent-not-found" },
    });
  });

  it("treats expired semantic handoffs as permanent destination results", async () => {
    const href = navigateAfterWrite(
      { commitPositions: [checkoutSource], commitEventIds: [] },
      "/account/cart",
      {
        nowMs: 1,
        handoff: {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          surface: "account-cart",
        },
      },
    );

    await expect(
      loadAfterWrite({
        request: new Request(`https://marketplace.chasesets.test${href}`),
        load: async () => ({ items: [], count: 0 }),
        isNotFound: () => false,
        isHandoffSatisfied: (cart, handoff) => handoff.expectation === "collection-non-empty" && cart.items.length > 0,
        nowMs: () => 40_000,
      }),
    ).resolves.toMatchObject({
      kind: "permanent-failure",
      reason: "semantic-handoff-expired",
      recoveryKind: "expired-handoff",
      state: { kind: "not-fresh-write", freshWrite: { kind: "expired" } },
    });
  });

  it("provides copyable semantic handoff fixtures for route tests", () => {
    const urls = semanticHandoffFixtureUrls(1_000);

    expect(readPostWriteHandoff(urls.valid, 1_000)).toEqual(semanticHandoffFixtureAddLine);
    expect(readPostWriteHandoff(urls.expired, 1_000)).toBeNull();
    expect(readPostWriteHandoffState(urls.expired, 1_000)).toMatchObject({ kind: "not-fresh-write" });
    expect(readPostWriteHandoffState(urls.farFuture, 1_000)).toMatchObject({ kind: "not-fresh-write" });
    expect(readPostWriteHandoffState(urls.malformed, 1_000)).toMatchObject({ kind: "malformed" });
    expect(readPostWriteHandoffState(urls.unpaired, 1_000)).toMatchObject({ kind: "not-fresh-write" });
    expect(readPostWriteHandoffState(urls.wrongKind, 1_000)).toMatchObject({
      kind: "valid",
      handoff: { kind: "marketplace.listing.publish" },
    });
    expect(urls.noOp).toBe("/account/cart");

    expect(semanticHandoffFixtureCartStates.staleEmpty).toEqual({ items: [], count: 0 });
    expect(semanticHandoffFixtureCartStates.satisfied.items).toHaveLength(1);
    expect(semanticHandoffFixtureDetailStates.stale).toMatchObject({ status: "draft" });
    expect(semanticHandoffFixtureDetailStates.updated).toMatchObject({ status: "published" });
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

    for (const status of [502, 503, 504]) {
      expect(
        classifyFreshWriteReadError({
          request: href,
          error: { status, body: null },
          nowMs: 1,
        }),
      ).toMatchObject({
        kind: "transient-gateway-timeout",
        transient: true,
        status,
        errorCode: null,
      });
    }
  });

  it("maps valid fresh-write projection lag to bounded temporary recovery", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);
    const projectionTimeout = classifyFreshWriteReadError({
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
    });

    expect(postWriteRecoveryKindForFreshWriteReadError(projectionTimeout)).toBe("refreshable-catching-up");
    expect(
      isBoundedTemporaryPostWriteRecoveryKind(postWriteRecoveryKindForFreshWriteReadError(projectionTimeout)),
    ).toBe(true);
  });

  it("maps valid semantic handoffs to bounded temporary recovery only while the receipt is valid", () => {
    const href = appendPostWriteHandoff(
      "/account/cart",
      { commitPositions: [checkoutSource], commitEventIds: [] },
      {
        kind: "checkout.cart.add-line",
        expectation: "collection-non-empty",
        surface: "account-cart",
      },
      1,
    );

    const validKind = postWriteRecoveryKindForHandoffState(readPostWriteHandoffState(href, 1));
    const expiredKind = postWriteRecoveryKindForHandoffState(readPostWriteHandoffState(href, 40_000));
    const malformedKind = postWriteRecoveryKindForHandoffState(
      readPostWriteHandoffState("/account/cart?postWriteHandoff=%7Bnot-json", 1),
    );
    const missingKind = postWriteRecoveryKindForHandoffState(readPostWriteHandoffState("/account/cart", 1));

    expect(validKind).toBe("pending-projection");
    expect(isBoundedTemporaryPostWriteRecoveryKind(validKind)).toBe(true);
    expect(expiredKind).toBe("expired-handoff");
    expect(isBoundedTemporaryPostWriteRecoveryKind(expiredKind)).toBe(false);
    expect(malformedKind).toBe("terminal-failure");
    expect(isBoundedTemporaryPostWriteRecoveryKind(malformedKind)).toBe(false);
    expect(missingKind).toBe("terminal-failure");
    expect(isBoundedTemporaryPostWriteRecoveryKind(missingKind)).toBe(false);
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

    expect(
      classifyFreshWriteReadError({
        request: "/checkout/chk_1",
        error: { status: 504, body: null },
        nowMs: 1,
      }),
    ).toMatchObject({
      kind: "not-fresh-write",
      transient: false,
      status: 504,
      errorCode: null,
    });
  });

  it("recovers fresh-write route-loader errors through the shared transient helper", () => {
    const href = appendFreshWriteToken("/checkout/chk_1", { commitPositions: [checkoutSource], commitEventIds: [] }, 1);
    const recovery = recoverFreshWriteReadError({
      request: href,
      error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
      nowMs: 1,
      recoverTransient: (classification) => ({
        status: 503,
        statusText: classification.kind,
      }),
    });

    expect(recovery).toEqual({
      status: 503,
      statusText: "transient-not-found",
    });
  });

  it("keeps permanent route-loader errors on the caller fallback path", () => {
    const recovery = recoverFreshWriteReadError({
      request: "/checkout/chk_1",
      error: { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
      nowMs: 1,
      recoverTransient: () => "transient",
      recoverPermanent: (classification) => (classification.kind === "permanent-not-found" ? "permanent" : null),
    });

    expect(recovery).toBe("permanent");
  });
});
