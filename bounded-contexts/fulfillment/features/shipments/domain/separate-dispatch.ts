import { t } from "@chase-sets/localization";
import { assertCanonicalFulfillmentMutationId } from "./mutation-attempt";
import { FulfillmentDomainError } from "./common";

export function assertSeparateDispatchInput(
  input: Readonly<{
    mutationAttemptId: string;
    confirmationText: string;
    reason: string;
  }>,
) {
  assertCanonicalFulfillmentMutationId(input.mutationAttemptId);
  if (input.confirmationText !== t("fulfillment.features.shipments.separate.confirmation") || !input.reason.trim())
    throw new FulfillmentDomainError(t("fulfillment.features.shipments.separate.confirmationRequired"));
}
