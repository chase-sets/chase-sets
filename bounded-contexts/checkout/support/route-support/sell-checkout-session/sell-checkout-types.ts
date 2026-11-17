import type { SellListReviewPlan } from "../../../features/sell-list/api/review-plan-contracts";
export type { SellListReviewPlan, SellListReviewPlanLine } from "../../../features/sell-list/api/review-plan-contracts";
import type {
  CheckoutSellListConfirmationRow,
  CheckoutSellListLineRow,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
} from "../../request-support/api-client";
import type {
  GuestSellCheckoutFormValues,
  GuestSellCheckoutRecovery,
} from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
  SignedInSellCheckoutRecovery,
  SignedInSellCheckoutShipFromAddress,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";

export type GuestSellCheckoutLoaderData = Readonly<{
  mode: "guest";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: GuestSellCheckoutRecovery | null;
  defaultValues: GuestSellCheckoutFormValues;
}>;

export type SignedInSellCheckoutLoaderData = Readonly<{
  mode: "signed-in";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: SignedInSellCheckoutRecovery | null;
  defaultValues: SignedInSellCheckoutFormValues;
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[];
  payoutSummary: SignedInSellCheckoutPayoutSummary | null;
  readinessDecisions: SellListReadinessDecisionInput;
  reviewPlan: SellListReviewPlan | null;
}>;

export type SellCheckoutLoaderData = GuestSellCheckoutLoaderData | SignedInSellCheckoutLoaderData;

export type SellListConfirmResponse = Readonly<{
  confirmation: CheckoutSellListConfirmationRow;
}>;
