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
  guestCheckoutContactFromForm,
  hasGuestCheckoutContact,
  isAccountSignInRequiredError,
  isCheckoutAuthorizationError,
  recoverGuestCheckoutStartMismatch,
  requestWithFreshWriteSource,
  signInPathForReturnTo,
  startGuestCheckoutSession,
  waitForMergedCartProjection,
  type GuestCheckoutStart,
} from "./checkout-start-guest";
import { checkoutSessionRequestFromForm, ensureCartReadinessSnapshot } from "./checkout-start-source";

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
  const api = createCheckoutRequestApiClient(request);
  const formData = await request.formData();
  const anonymousCartId = readAnonymousCartId(request);
  const sourceType = String(formData.get("source") ?? "cart");

  if (actor) {
    try {
      const forceReadinessRefresh = sourceType === "cart";
      let sessionApi = api;
      const writeSources: unknown[] = [];
      if (sourceType === "cart" && anonymousCartId) {
        const mergeResult = await api.mergeGuestCartToAccount(anonymousCartId);
        writeSources.push(mergeResult);
        await waitForMergedCartProjection(api, mergeResult);
        sessionApi = createCheckoutRequestApiClient(requestWithFreshWriteSource(request, mergeResult));
      }

      const sessionRequest = await ensureCartReadinessSnapshot(sessionApi, checkoutSessionRequestFromForm(formData), {
        forceRefresh: forceReadinessRefresh,
      });
      const session = await sessionApi.createCheckoutSession(sessionRequest);
      const response = redirect(await checkoutSessionPath(session, writeSources));
      if (anonymousCartId) {
        appendClearedAnonymousCartCookie(response.headers, request);
      }

      return response;
    } catch (error) {
      const recovered = await recoverGuestCheckoutStartMismatch(error, actor, request, formData, {
        anonymousCartId,
        sourceType,
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

  const contact = guestCheckoutContactFromForm(formData);
  if (!hasGuestCheckoutContact(contact)) {
    return null;
  }

  let guest: GuestCheckoutStart;

  try {
    guest = await createGuestCheckoutStart(request, contact);
  } catch (error) {
    if (isAccountSignInRequiredError(error)) {
      return {
        emailExistsError: t("checkout.routes.checkoutStart.email.already.has.account"),
        signInPath: signInPathForReturnTo(currentPathWithSearch(request)),
      };
    }

    throw error;
  }

  try {
    return await startGuestCheckoutSession(request, formData, { anonymousCartId, sourceType, guest });
  } catch (error) {
    if (isCheckoutAuthorizationError(error) && canRecoverGuestCheckoutMismatch(sourceType, anonymousCartId)) {
      let retryGuest: GuestCheckoutStart;
      try {
        retryGuest = await createGuestCheckoutStart(request, contact);
      } catch {
        return recoverCheckoutStartError(error, actor, request);
      }

      try {
        return await startGuestCheckoutSession(request, formData, {
          anonymousCartId,
          sourceType,
          guest: retryGuest,
        });
      } catch (retryError) {
        return recoverCheckoutStartError(retryError, null, request);
      }
    }

    return recoverCheckoutStartError(error, actor, request);
  }
}
