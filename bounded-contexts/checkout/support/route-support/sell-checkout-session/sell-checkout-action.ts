import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import { redirect, type ActionFunctionArgs } from "react-router";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../../request-support/api-client";
import { resolveCheckoutShopifySimpleUnavailableState } from "../../request-support/checkout-release-control";
import type { GuestSellCheckoutActionState } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type { SignedInSellCheckoutActionState } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import {
  applySelectedSavedShipFromAddress,
  hasFieldErrors,
  normalizeText,
  signedInValuesFromFormData,
  validateSignedInSellCheckoutValues,
  valuesFromFormData,
  validateGuestSellCheckoutValues,
} from "./sell-checkout-form";
import {
  assertMarketplaceOfferTermsFresh,
  buildSellerEvidence,
  performMarketplaceHandoff,
} from "./sell-checkout-handoff";
import {
  canUseSignedInSellCheckout,
  loadGuestSellCheckoutState,
  loadSignedInSellCheckoutState,
} from "./sell-checkout-loader";
import {
  confirmationPathForSession,
  confirmationIdForSession,
  encodeSellListReadinessDecisions,
  parseSellListReadinessDecisions,
  parseSellListReviewPlan,
  reviewedLinesForConfirmation,
} from "./sell-checkout-readiness";
import { SellListReviewPlanStaleError } from "./sell-checkout-types";
import { SELLER_CHECKOUT_REGISTER_HREF } from "../../../features/sell-list/ui/registration-return";

async function getExistingSellListConfirmation(
  api: ReturnType<typeof createCheckoutRequestApiClient>,
  confirmationId: string,
) {
  return api.getSellListConfirmation(confirmationId).catch((error) => {
    if (error instanceof CheckoutApiError && error.status === 404) {
      return null;
    }

    throw error;
  });
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<GuestSellCheckoutActionState | SignedInSellCheckoutActionState | Response> {
  const actor = await resolveActorFromAuthApi({ request });
  const unavailable = await resolveCheckoutShopifySimpleUnavailableState(request, actor, "sell");
  if (unavailable) {
    return redirect(unavailable.redirectPath);
  }

  const formData = await request.formData();
  if (canUseSignedInSellCheckout(actor)) {
    const api = createCheckoutRequestApiClient(request);
    const submittedValues = signedInValuesFromFormData(formData);
    const readinessDecisions = parseSellListReadinessDecisions(normalizeText(formData.get("readinessDecisions")));
    const state = await loadSignedInSellCheckoutState(request, params.sessionId ?? createId("chk"), {
      readinessSnapshotId: normalizeText(formData.get("readinessSnapshotId")),
      readinessSourceRevision: normalizeText(formData.get("readinessSourceRevision")),
      readinessDecisions,
      readinessDecisionsJson: encodeSellListReadinessDecisions(readinessDecisions),
      sellListReviewPlanJson: normalizeText(formData.get("sellListReviewPlan")),
    });
    const values = applySelectedSavedShipFromAddress(submittedValues, state.savedShipFromAddresses);

    if (state.recovery) {
      return {
        status: "error",
        values,
        recovery: state.recovery,
        fieldErrors: {
          form: t("checkout.routes.sellCheckoutSession.validation.readiness.recovery"),
        },
      };
    }

    const fieldErrors = validateSignedInSellCheckoutValues(values);
    if (state.payoutSummary?.status !== "ready") {
      fieldErrors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.setup.required");
    }
    if (hasFieldErrors(fieldErrors)) {
      return {
        status: "error",
        values,
        fieldErrors,
      };
    }

    if (!state.readiness) {
      return {
        status: "error",
        values,
        fieldErrors: {
          form: t("checkout.routes.sellCheckoutSession.validation.readiness.recovery"),
        },
      };
    }

    const confirmationId = confirmationIdForSession(state.sessionId);
    const existingConfirmation = await getExistingSellListConfirmation(api, confirmationId);
    if (existingConfirmation) {
      return redirect(confirmationPathForSession(state.sessionId));
    }

    try {
      const reviewPlan = parseSellListReviewPlan(state.sellListReviewPlan);
      const reviewedLines = reviewedLinesForConfirmation(state.lines, state.readiness, reviewPlan);
      const marketplaceApi = createMarketplaceRequestApiClient(request);
      await assertMarketplaceOfferTermsFresh(marketplaceApi, reviewedLines);
      const marketplaceHandoff = await performMarketplaceHandoff(marketplaceApi, confirmationId, reviewedLines);
      const confirmedAt = new Date().toISOString();
      const sellerEvidence = buildSellerEvidence(values, state.payoutSummary, confirmedAt);
      await api.confirmSellListCheckout({
        confirmationId,
        readinessSnapshotId: state.readiness.snapshotId,
        readinessSourceRevision: state.readiness.sourceRevision,
        readinessDecisions,
        completedLineIds: marketplaceHandoff.completedLineIds,
        remainingLineQuantities: marketplaceHandoff.remainingLineQuantities,
        sellerEvidence,
        handoffSummary: marketplaceHandoff.summary,
      });

      return redirect(confirmationPathForSession(state.sessionId));
    } catch (error) {
      if (error instanceof SellListReviewPlanStaleError) {
        return {
          status: "error",
          values,
          recovery: error.recovery,
          fieldErrors: {
            form: error.message,
          },
        };
      }

      return {
        status: "error",
        values,
        fieldErrors: {
          form:
            error instanceof Error
              ? error.message
              : t("checkout.routes.sellCheckoutSession.validation.review.plan.required"),
        },
      };
    }
  }

  const values = valuesFromFormData(formData);
  const state = await loadGuestSellCheckoutState(request, params.sessionId ?? createId("chk"), {
    readinessSnapshotId: normalizeText(formData.get("readinessSnapshotId")),
    readinessSourceRevision: normalizeText(formData.get("readinessSourceRevision")),
  });

  if (state.recovery) {
    return {
      status: "error",
      values,
      recovery: state.recovery,
      fieldErrors: {
        form: t("checkout.routes.sellCheckoutSession.validation.readiness.recovery"),
      },
    };
  }

  const fieldErrors = validateGuestSellCheckoutValues(values);
  if (hasFieldErrors(fieldErrors)) {
    return {
      status: "error",
      values,
      fieldErrors,
    };
  }

  return redirect(SELLER_CHECKOUT_REGISTER_HREF);
}
