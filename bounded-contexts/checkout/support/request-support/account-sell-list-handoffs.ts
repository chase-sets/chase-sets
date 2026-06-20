import type { PostWriteHandoff } from "@chase-sets/http/responses";

export const ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND = "checkout.sell-list.add-line";

export const ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF = {
  kind: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND,
  expectation: "collection-non-empty",
  surface: "account-sell-list",
} as const satisfies PostWriteHandoff;

export function isAccountSellListAddLineHandoff(handoff: PostWriteHandoff) {
  return handoff.kind === ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF_KIND && handoff.expectation === "collection-non-empty";
}

export function isPendingAccountSellListAddLineHandoff(
  sellList: Readonly<{ items: readonly unknown[]; count: number }>,
  handoff: PostWriteHandoff,
) {
  return isAccountSellListAddLineHandoff(handoff) && sellList.items.length === 0 && sellList.count === 0;
}
