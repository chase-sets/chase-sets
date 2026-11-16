import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWriteFromSourcesWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import { redirect, type ActionFunctionArgs } from "react-router";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../../request-support/api-client";
import type { GuestSellCheckoutActionState } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type { SignedInSellCheckoutActionState } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import {
  applySelectedSavedShipFromAddress,
  hasFieldErrors,
  normalizeText,
  objectValue,
  signedInValuesFromFormData,
  validateSignedInSellCheckoutValues,
  valuesFromFormData,
  validateGuestSellCheckoutValues,
} from "./sell-checkout-form";
import {
  buildSellerEvidence,
  performMarketplaceHandoff,
  SellListHandoffInterruptedError,
} from "./sell-checkout-handoff";
import {
  canUseSignedInSellCheckout,
  loadGuestSellCheckoutState,
  loadSignedInSellCheckoutState,
} from "./sell-checkout-loader";
import {
  confirmationPathForSession,
  confirmationIdForSession,
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
  const formData = await request.formData();
  const retainedFields = [...formData.entries()].filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (canUseSignedInSellCheckout(actor)) {
    const api = createCheckoutRequestApiClient(request);
    const submittedValues = signedInValuesFromFormData(formData);
    const sessionId = params.sessionId ?? createId("chk");
    const confirmationId = confirmationIdForSession(sessionId);
    let existingConfirmation;
    try {
      existingConfirmation = await getExistingSellListConfirmation(api, confirmationId);
    } catch {
      return {
        status: "error",
        values: submittedValues,
        fieldErrors: {},
        attempt: { state: "ambiguous", fields: retainedFields, lines: [] },
      };
    }
    if (existingConfirmation) return redirect(confirmationPathForSession(sessionId));
    const state = await loadSignedInSellCheckoutState(request, sessionId, {
      readinessSnapshotId: normalizeText(formData.get("readinessSnapshotId")),
      readinessSourceRevision: normalizeText(formData.get("readinessSourceRevision")),
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

    try {
      const readinessDecisions = state.readinessDecisions;
      const reviewedLines = reviewedLinesForConfirmation(state.lines, state.readiness, state.reviewPlan);
      const marketplaceApi = createMarketplaceRequestApiClient(request);
      const sellerEvidence = buildSellerEvidence(values, state.payoutSummary);
      const choices = {
        shipFrom:
          values.shipFromAddressId === "__manual"
            ? {
                name: values.shipFromName,
                line1: values.shipFromLine1,
                line2: values.shipFromLine2 || null,
                city: values.shipFromCity,
                state: values.shipFromState,
                postalCode: values.shipFromPostalCode,
                country: values.shipFromCountry,
              }
            : { addressId: values.shipFromAddressId },
        label: { preference: sellerEvidence.label.preference },
      };
      const sellerReadiness = await api.createSellListReadiness({
        ...readinessDecisions,
        ...choices,
        sellerEvidence,
        confirmationId,
        entryReadinessSnapshotId: state.readiness.snapshotId,
        entryReadinessSourceRevision: state.readiness.sourceRevision,
      });
      if (
        sellerReadiness.readiness.status !== "ready" ||
        sellerReadiness.readiness.unresolvedLineIds.length > 0 ||
        sellerReadiness.readiness.sellerReadiness.status !== "ready"
      ) {
        throw new Error(t("checkout.routes.sellCheckoutSession.validation.readiness.recovery"));
      }
      const marketplaceHandoff = await performMarketplaceHandoff(
        marketplaceApi,
        confirmationId,
        reviewedLines,
        actor!.accountId,
      );
      const confirmationBody = {
        confirmationId,
        readinessSnapshotId: sellerReadiness.readiness.snapshotId,
        readinessSourceRevision: sellerReadiness.readiness.sourceRevision,
        readinessDecisions,
        completedLineIds: marketplaceHandoff.completedLineIds,
        remainingLineQuantities: marketplaceHandoff.remainingLineQuantities,
        ...choices,
        sellerEvidence,
        handoffSummary: marketplaceHandoff.summary,
      };
      let result;
      try {
        result = await api.confirmSellListCheckout(confirmationBody);
      } catch (error) {
        const status = error instanceof CheckoutApiError ? error.status : null;
        if (status !== null && status !== 408 && status < 500) throw error;
        const confirmed = await getExistingSellListConfirmation(api, confirmationId).catch(() => null);
        if (confirmed) return redirect(confirmationPathForSession(state.sessionId));
        return {
          status: "error",
          values,
          fieldErrors: {},
          attempt: { state: "ambiguous", fields: retainedFields, lines: [] },
        };
      }

      return redirect(
        await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
          [result, ...marketplaceHandoff.writeResults],
          confirmationPathForSession(state.sessionId),
        ),
      );
    } catch (error) {
      if (error instanceof SellListHandoffInterruptedError) {
        return {
          status: "error",
          values,
          fieldErrors: { form: error.message },
          ...(error.reason instanceof SellListReviewPlanStaleError ? { recovery: error.reason.recovery } : {}),
          attempt: {
            state: "partial",
            fields: retainedFields,
            lines: error.lines.map((line) => ({ id: line.lineId, status: line.status })),
          },
        };
      }
      if (
        error instanceof CheckoutApiError &&
        objectValue(objectValue(error.body)?.error)?.code === "checkout_readiness_stale"
      ) {
        return {
          status: "error",
          values,
          recovery: { kind: "readiness-stale" },
          fieldErrors: { form: error.message },
        };
      }
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
        attempt: { state: "failed-safe", fields: retainedFields, lines: [] },
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
