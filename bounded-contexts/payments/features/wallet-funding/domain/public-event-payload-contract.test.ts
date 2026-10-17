import { expectTypeOf, it } from "vitest";
import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import type { WalletFundingFact, WalletFundingRefundFact, WalletFundingDisputeFact } from "./domain";

it("publishes funding economics and exact refund reservation identity through the real public contracts", () => {
  expectTypeOf<WalletFundingFact>().toMatchTypeOf<ChaseSetsEventPayloads["payments.wallet-funding-captured"]>();
  expectTypeOf<WalletFundingRefundFact>().toMatchTypeOf<ChaseSetsEventPayloads["payments.wallet-funding-refunded"]>();
  expectTypeOf<WalletFundingDisputeFact>().toMatchTypeOf<
    ChaseSetsEventPayloads["payments.wallet-funding-dispute-recorded"]
  >();
});
