import {
  appendPostWriteHandoff,
  encodePostWriteHandoff,
  type PostWriteHandoff,
  type SourceCommitPosition,
} from "./responses";

export const semanticHandoffFixtureSource = {
  sourceContextName: "checkout",
  maxGlobalPosition: "42",
  eventIds: ["evt_checkout_cart_line"],
} as const satisfies SourceCommitPosition;

export const semanticHandoffFixtureCommit = {
  commitPositions: [semanticHandoffFixtureSource],
  commitEventIds: ["evt_checkout_cart_line"],
};

export const semanticHandoffFixtureAddLine = {
  kind: "checkout.cart.add-line",
  expectation: "collection-non-empty",
  surface: "account-cart",
} as const satisfies PostWriteHandoff;

export const semanticHandoffFixtureWrongKind = {
  kind: "marketplace.listing.publish",
  expectation: "resource-updated",
  surface: "account-listing",
} as const satisfies PostWriteHandoff;

export const semanticHandoffFixtureCartStates = {
  staleEmpty: { items: [], count: 0 },
  satisfied: { items: [{ line_id: "cli_fixture" }], count: 1 },
} as const;

export const semanticHandoffFixtureDetailStates = {
  stale: { id: "lst_fixture", status: "draft", version: 1 },
  updated: { id: "lst_fixture", status: "published", version: 2 },
} as const;

export function semanticHandoffFixtureUrls(nowMs = 1_000) {
  const valid = appendPostWriteHandoff(
    "/account/cart",
    semanticHandoffFixtureCommit,
    semanticHandoffFixtureAddLine,
    nowMs,
  );
  const expired = appendPostWriteHandoff(
    "/account/cart",
    semanticHandoffFixtureCommit,
    semanticHandoffFixtureAddLine,
    nowMs - 40_000,
  );
  const farFuture = appendPostWriteHandoff(
    "/account/cart",
    semanticHandoffFixtureCommit,
    semanticHandoffFixtureAddLine,
    nowMs + 60_000,
  );
  const wrongKind = appendPostWriteHandoff(
    "/account/cart",
    semanticHandoffFixtureCommit,
    semanticHandoffFixtureWrongKind,
    nowMs,
  );
  const validAfterWrite = new URL(valid, "https://chase-sets.local").searchParams.get("afterWrite");

  return {
    valid,
    expired,
    farFuture,
    malformed: `/account/cart?afterWrite=${validAfterWrite}&postWriteHandoff=%7Bnot-json`,
    unpaired: `/account/cart?postWriteHandoff=${encodePostWriteHandoff(semanticHandoffFixtureAddLine)}`,
    wrongKind,
    noOp: appendPostWriteHandoff("/account/cart", { status: "accepted" }, semanticHandoffFixtureAddLine, nowMs),
  } as const;
}
