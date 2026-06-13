import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import { redirect, type ActionFunctionArgs } from "react-router";
import { createCheckoutRequestApiClient } from "../../request-support/api-client";
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
  confirmationSideEffects,
  performMarketplaceHandoff,
} from "./sell-checkout-handoff";
import {
  canUseSignedInSellCheckout,
  loadGuestSellCheckoutState,
  loadSignedInSellCheckoutState,
} from "./sell-checkout-loader";
import {
  confirmationIdForSession,
  encodeSellListReadinessDecisions,
  parseSellListReadinessDecisions,
  parseSellListReviewPlan,
  reviewedLinesForConfirmation,
} from "./sell-checkout-readiness";
import { SellListReviewPlanStaleError, type SellListConfirmResponse } from "./sell-checkout-types";
import { SELLER_CHECKOUT_REGISTER_HREF } from "../../../features/sell-list/ui/registration-return";

function estimatedTotalFor(
  lines: readonly {
    offer_price_amount?: string | null;
    minimum_listing_price_amount?: string | null;
    quantity: number;
  }[],
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(
    lines.reduce(
      (sum, line) => sum + Number(line.offer_price_amount ?? line.minimum_listing_price_amount ?? 0) * line.quantity,
      0,
    ),
  );
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
    const estimatedTotal = estimatedTotalFor(state.lines);
    const existingConfirmation = await api.getSellListConfirmation(confirmationId).catch(() => null);
    if (existingConfirmation) {
      return {
        status: "confirmed",
        values,
        confirmation: {
          referenceId: existingConfirmation.confirmation_id,
          sellerName: values.sellerName,
          estimatedTotal,
          sideEffects: confirmationSideEffects(existingConfirmation.handoff_summary),
        },
      };
    }

    try {
      const reviewPlan = parseSellListReviewPlan(state.sellListReviewPlan);
      const reviewedLines = reviewedLinesForConfirmation(state.lines, state.readiness, reviewPlan);
      const marketplaceApi = createMarketplaceRequestApiClient(request);
      await assertMarketplaceOfferTermsFresh(marketplaceApi, reviewedLines);
      const marketplaceHandoff = await performMarketplaceHandoff(marketplaceApi, confirmationId, reviewedLines);
      const confirmedAt = new Date().toISOString();
      const sellerEvidence = buildSellerEvidence(values, state.payoutSummary, confirmedAt);
      const result = (await api.confirmSellListCheckout({
        confirmationId,
        readinessSnapshotId: state.readiness.snapshotId,
        readinessSourceRevision: state.readiness.sourceRevision,
        readinessDecisions,
        completedLineIds: marketplaceHandoff.completedLineIds,
        remainingLineQuantities: marketplaceHandoff.remainingLineQuantities,
        sellerEvidence,
        handoffSummary: marketplaceHandoff.summary,
      })) as SellListConfirmResponse;

      return {
        status: "confirmed",
        values,
        confirmation: {
          referenceId: result.confirmation.confirmation_id,
          sellerName: values.sellerName,
          estimatedTotal,
          sideEffects: confirmationSideEffects(result.confirmation.handoff_summary),
        },
      };
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
