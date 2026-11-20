import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs } from "react-router";
import { redirect, redirectDocument } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../../request-support/api-client";
import { checkoutRecoveryForError, checkoutRecoveryForKind } from "../../../features/sessions/api/checkout-recovery";
import { appendClearedAnonymousCartCookie, readAnonymousCartId } from "../../request-support/guest-checkout";
import type { CheckoutStartActionData } from "../../../features/sessions/ui/checkout-start-page-types";
import {
  checkoutSessionPath,
  currentPathWithSearch,
  isGuestEntryRequest,
  recoverGuestCheckoutStartMismatch,
  signInPathForReturnTo,
  startGuestCheckoutEntry,
} from "./checkout-start-guest";
import { checkoutSessionRequestFromForm, ensureCartReadinessSnapshot, sourceFromUrl } from "./checkout-start-source";
import { checkoutStartEntryRefusedBeforeSend, openCheckoutSessionOnce } from "./checkout-start-entry";

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

/**
 * Every Session write runs as an account the request presented. A signed-out
 * start writes nothing: it mints a guest and sends the same POST on to itself
 * (`startGuestCheckoutEntry`), and that followed POST opens the Session here as
 * the guest it presents.
 */
export async function action({ request }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const formData = await request.formData();
  const anonymousCartId = readAnonymousCartId(request);
  const authoritativeSource = sourceFromUrl(new URL(request.url));
  const sourceType = authoritativeSource?.type ?? String(formData.get("source") ?? "cart");
  const anonymousCartHeaders = anonymousCartId ? { "x-checkout-anonymous-cart-id": anonymousCartId } : undefined;
  const guestEntry = isGuestEntryRequest(request);
  // A form without a usable entry key is refused before its branch's first
  // write: no cart merge, no readiness snapshot, no guest, no Session.
  const entryRefusedBeforeSend = checkoutStartEntryRefusedBeforeSend(formData, sourceType);
  const attemptChanged = () => ({
    recovery: checkoutRecoveryForKind("attempt-changed", currentPathWithSearch(request)),
  });
  const api = createCheckoutRequestApiClient(request, { headers: anonymousCartHeaders });

  if (actor) {
    if (entryRefusedBeforeSend) {
      return attemptChanged();
    }
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
      const entry = await openCheckoutSessionOnce(api, sessionRequest, anonymousCartId);
      if (entry.kind === "ambiguous") {
        return { entryState: "ambiguous" as const };
      }
      const sessionPath = await checkoutSessionPath(entry.session, writeSources);
      // A followed guest entry keeps the guest document redirect, so the page
      // reloads as the guest the request just presented.
      const response = guestEntry ? redirectDocument(sessionPath) : redirect(sessionPath);
      if (anonymousCartId) {
        appendClearedAnonymousCartCookie(response.headers, request);
      }

      return response;
    } catch (error) {
      const recovered = await recoverGuestCheckoutStartMismatch(error, actor, request, {
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

  if (entryRefusedBeforeSend) {
    return attemptChanged();
  }

  // The followed POST presented no resolvable guest: the browser refused the
  // cookie or it expired. Minting again could only loop, so nothing is minted.
  if (guestEntry) {
    return { recovery: checkoutRecoveryForKind("guest-access-expired", currentPathWithSearch(request)) };
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

  return startGuestCheckoutEntry(request);
}
