import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../../request-support/api-client";
import { checkoutRecoveryForError, checkoutRecoveryForKind } from "../../../features/sessions/api/checkout-recovery";
import { appendClearedAnonymousCartCookie, readAnonymousCartId } from "../../request-support/guest-checkout";
import type { CheckoutStartActionData } from "../../../features/sessions/ui/checkout-start-page-types";
import {
  canRecoverGuestCheckoutMismatch,
  checkoutSessionPath,
  createGuestCheckoutStart,
  currentPathWithSearch,
  isCheckoutAuthorizationError,
  recoverGuestCheckoutStartMismatch,
  signInPathForReturnTo,
  startGuestCheckoutSession,
  type GuestCheckoutStart,
} from "./checkout-start-guest";
import { checkoutSessionRequestFromForm, ensureCartReadinessSnapshot, sourceFromUrl } from "./checkout-start-source";

function recoverCheckoutStartError(
  error: unknown,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  request: Request,
): CheckoutStartActionData {
  const recovery = checkoutRecoveryForError(error, actor, currentPathWithSearch(request));
  if (!recovery) {
    throw error;
  }

  return { recovery };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const formData = await request.formData();
  const anonymousCartId = readAnonymousCartId(request);
  const authoritativeSource = sourceFromUrl(new URL(request.url));
  const sourceType = authoritativeSource?.type ?? String(formData.get("source") ?? "cart");
  const anonymousCartHeaders = anonymousCartId ? { "x-checkout-anonymous-cart-id": anonymousCartId } : undefined;
  const api = createCheckoutRequestApiClient(request, { headers: anonymousCartHeaders });

  if (actor) {
    try {
      const forceReadinessRefresh = sourceType === "cart";
      const writeSources: unknown[] = [];
      if (sourceType === "cart" && anonymousCartId) {
        try {
          writeSources.push(await api.mergeGuestCartToAccount(anonymousCartId));
        } catch {
          // The cart API owns the redacted failure signal. Entry continues from
          // the Account-plus-presented-anonymous union in the original client.
        }
      }

      const sessionRequest = await ensureCartReadinessSnapshot(
        api,
        checkoutSessionRequestFromForm(formData, authoritativeSource),
        { forceRefresh: forceReadinessRefresh },
      );
      const session = await api.createCheckoutSession(sessionRequest);
      const response = redirect(await checkoutSessionPath(session, writeSources));
      if (anonymousCartId) {
        appendClearedAnonymousCartCookie(response.headers, request);
      }

      return response;
    } catch (error) {
      const recovered = await recoverGuestCheckoutStartMismatch(error, actor, request, formData, {
        anonymousCartId,
        sourceType,
        source: authoritativeSource,
      });
      if (recovered) {
        return recovered;
      }

      return recoverCheckoutStartError(error, actor, request);
    }
  }

  if (sourceType === "offer-intent") {
    return {
      error: t("checkout.routes.checkoutStart.register.or.sign.in.to.place.purchase.intent"),
      signInPath: signInPathForReturnTo(currentPathWithSearch(request)),
    };
  }

  if (sourceType === "cart") {
    try {
      const cart = await api.getGuestCart(anonymousCartId);
      if (cart.count === 0) {
        return { recovery: checkoutRecoveryForKind("cart-empty", currentPathWithSearch(request)) };
      }
    } catch (error) {
      return recoverCheckoutStartError(error, actor, request);
    }
  }

  const guest = await createGuestCheckoutStart(request);

  try {
    return await startGuestCheckoutSession(request, formData, {
      anonymousCartId,
      sourceType,
      source: authoritativeSource,
      guest,
    });
  } catch (error) {
    if (isCheckoutAuthorizationError(error) && canRecoverGuestCheckoutMismatch(sourceType, anonymousCartId)) {
      let retryGuest: GuestCheckoutStart;
      try {
        retryGuest = await createGuestCheckoutStart(request);
      } catch {
        return recoverCheckoutStartError(error, actor, request);
      }

      try {
        return await startGuestCheckoutSession(request, formData, {
          anonymousCartId,
          sourceType,
          source: authoritativeSource,
          guest: retryGuest,
        });
      } catch (retryError) {
        return recoverCheckoutStartError(retryError, null, request);
      }
    }

    return recoverCheckoutStartError(error, actor, request);
  }
}
