import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  appendFreshWriteToken,
  evaluatePostWriteHandoff,
  loadFreshlyWrittenResource,
  readPostWriteHandoffState,
  recoverFreshWriteReadError,
  type PostWriteHandoffState,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  recordPlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyOutcome,
} from "@chase-sets/platform-runtime/post-write-consistency";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { readAnonymousCartId } from "../support/request-support/guest-checkout";
import {
  ACCOUNT_CART_ADD_LINE_HANDOFF_KIND,
  isAccountCartAddLineHandoff,
  isPendingAccountCartAddLineHandoff,
} from "../support/request-support/account-cart-handoffs";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";

const MARKETPLACE_DESCRIPTION = t("checkout.routes.accountCart.review.cart.lines.adjust.quantity.and");

function canUseAccountCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

function latestWriteResult(results: readonly unknown[]): unknown {
  return [...results].reverse().find((result) => result !== undefined && result !== null) ?? null;
}

function checkoutApiErrorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}

function checkoutApiErrorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error ? (error as { body: unknown }).body : null;
}

function checkoutApiErrorCode(error: unknown) {
  const body = checkoutApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return code === null || code === undefined ? null : String(code);
}

type AccountCartActorMode = "account" | "guest";

function freshnessOutcomeForHandoffState(state: PostWriteHandoffState) {
  if (state.kind === "valid") {
    return "valid-after-write";
  }

  if (state.kind === "malformed") {
    return "malformed-handoff";
  }

  switch (state.freshWrite.kind) {
    case "expired":
      return "expired-after-write";
    case "malformed":
      return "malformed-after-write";
    case "future":
      return "future-after-write";
    case "missing":
      return "missing-after-write";
    case "valid":
      return "valid-after-write";
  }
}

function recordAccountCartSemanticHandoffOutcome(
  actorMode: AccountCartActorMode,
  outcome: PlatformPostWriteConsistencyOutcome,
  freshnessOutcome: string,
  recoveryAction: string,
) {
  recordPlatformPostWriteConsistencyEvent({
    boundedContextName: "checkout",
    surface: "account-cart",
    strategy: "fresh-read",
    outcome,
    routeId: "account-cart",
    routeTemplate: "/account/cart",
    correctionSource: `semantic-handoff:${ACCOUNT_CART_ADD_LINE_HANDOFF_KIND}`,
    actorMode,
    recoveryAction,
    freshnessOutcome,
  });
}

function recordNotApplicableAccountCartHandoffState(actorMode: AccountCartActorMode, state: PostWriteHandoffState) {
  if (state.kind === "missing") {
    return;
  }

  const outcome =
    state.kind === "malformed"
      ? "handoff_malformed"
      : state.freshWrite.kind === "expired"
        ? "handoff_expired"
        : "handoff_invalid";
  recordAccountCartSemanticHandoffOutcome(actorMode, outcome, freshnessOutcomeForHandoffState(state), "none");
}

async function loadCartWithPostWriteRecovery<TCart extends { items: readonly unknown[]; count: number }>(
  request: Request,
  load: () => Promise<TCart>,
  actorMode: AccountCartActorMode,
) {
  try {
    const cart = await loadFreshlyWrittenResource({
      request,
      load,
      isNotFound: (error) => checkoutApiErrorStatus(error) === 404,
    });
    const handoffDecisionAtMs = Date.now();
    const handoffState = readPostWriteHandoffState(request, handoffDecisionAtMs);
    const handoff = evaluatePostWriteHandoff({
      request,
      data: cart,
      nowMs: handoffDecisionAtMs,
      isSatisfied: (candidate, postWriteHandoff) =>
        isAccountCartAddLineHandoff(postWriteHandoff) &&
        !isPendingAccountCartAddLineHandoff(candidate, postWriteHandoff),
    });
    if (handoff.kind === "not-applicable") {
      recordNotApplicableAccountCartHandoffState(actorMode, handoff.state);
    } else if (!isAccountCartAddLineHandoff(handoff.handoff)) {
      recordAccountCartSemanticHandoffOutcome(actorMode, "handoff_invalid", "valid-after-write", "none");
    } else if (handoff.kind === "pending") {
      recordAccountCartSemanticHandoffOutcome(
        actorMode,
        "handoff_pending",
        freshnessOutcomeForHandoffState(handoffState),
        "pending_empty_state",
      );
      return {
        cart,
        freshnessError: null,
        pendingCartMessage: t("checkout.routes.accountCart.adding.item.description"),
      };
    } else {
      recordAccountCartSemanticHandoffOutcome(
        actorMode,
        "handoff_satisfied",
        freshnessOutcomeForHandoffState(handoffState),
        "none",
      );
    }

    return { cart, freshnessError: null, pendingCartMessage: null };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: checkoutApiErrorStatus,
      getErrorCode: checkoutApiErrorCode,
      getBody: checkoutApiErrorBody,
      recoverTransient: () => ({
        cart: { items: [], count: 0 },
        freshnessError: t("checkout.routes.accountCart.request.failed"),
        pendingCartMessage: null,
      }),
    });
    if (recovery) {
      return recovery;
    }

    throw error;
  }
}

function cartLineIdsFromForm(formData: FormData) {
  return formData
    .getAll("lineId")
    .map((lineId) => String(lineId ?? "").trim())
    .filter(Boolean);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });

  if (!canUseAccountCart(actor)) {
    return loadCartWithPostWriteRecovery(request, () => api.getGuestCart(readAnonymousCartId(request)), "guest");
  }

  return loadCartWithPostWriteRecovery(request, () => api.getCart(), "account");
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intentValues = formData.getAll("intent");
  const intent = String(intentValues.at(-1) ?? "");
  const api = createCheckoutRequestApiClient(request);
  const actor = await resolveActorFromAuthApi({ request });
  const anonymousCartId = readAnonymousCartId(request);
  const useAccountCart = canUseAccountCart(actor);

  try {
    if (intent === "update-cart-line") {
      const lineIds = cartLineIdsFromForm(formData);
      const [primaryLineId, ...duplicateLineIds] = lineIds;

      const absoluteQuantity = Number(formData.get("quantity") ?? NaN);
      const usesOptimisticCorrection =
        formData.get("optimisticStrategy") === "optimistic-with-correction" &&
        String(formData.get("correctionSource") ?? "").startsWith("fresh-read:");
      const enteredQuantity = Number(formData.get("quantity") ?? 1);
      const quantityDelta = Number(formData.get("quantityDelta") ?? 0);
      const safeEnteredQuantity = Number.isFinite(enteredQuantity) ? enteredQuantity : 1;
      const nextQuantity = Math.max(
        1,
        usesOptimisticCorrection && Number.isFinite(absoluteQuantity)
          ? absoluteQuantity
          : safeEnteredQuantity + (Number.isFinite(quantityDelta) ? quantityDelta : 0),
      );

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all([
          api.updateGuestCartLineQuantity(anonymousCartId, primaryLineId ?? "", {
            quantity: nextQuantity,
          }),
          ...duplicateLineIds.map((lineId) => api.removeGuestCartLine(anonymousCartId, lineId)),
        ]);
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all([
        api.updateCartLineQuantity(primaryLineId ?? "", {
          quantity: nextQuantity,
        }),
        ...duplicateLineIds.map((lineId) => api.removeCartLine(lineId)),
      ]);
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    if (intent === "lock-preferred-listing") {
      const lineIds = cartLineIdsFromForm(formData);
      const sellerPreferenceId = String(formData.get("sellerPreferenceId") ?? "").trim();
      if (!sellerPreferenceId || lineIds.length === 0) {
        throw new Error(t("checkout.routes.accountCart.preferred.listing.missing"));
      }

      const fulfillment = {
        fulfillmentMode: "locked-listing" as const,
        lockedListingId: sellerPreferenceId,
        sellerPreferenceId,
        availabilityState: "available" as const,
      };

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(
          lineIds.map((lineId) => api.updateGuestCartLineFulfillment(anonymousCartId, lineId, fulfillment)),
        );
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(lineIds.map((lineId) => api.updateCartLineFulfillment(lineId, fulfillment)));
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    if (intent === "remove-cart-line") {
      const lineIds = cartLineIdsFromForm(formData);

      if (!useAccountCart && anonymousCartId) {
        const results = await Promise.all(lineIds.map((lineId) => api.removeGuestCartLine(anonymousCartId, lineId)));
        return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await Promise.all(lineIds.map((lineId) => api.removeCartLine(lineId)));
      return redirect(appendFreshWriteToken("/account/cart", latestWriteResult(results)));
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("checkout.routes.accountCart.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.accountCart.cart.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutAccountCartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const freshnessError = "freshnessError" in data ? data.freshnessError : null;
  const pendingCartMessage = "pendingCartMessage" in data ? data.pendingCartMessage : null;

  return (
    <CheckoutCartPage
      cartLines={data.cart.items}
      errorMessage={actionData?.error ?? freshnessError}
      pendingEmptyMessage={pendingCartMessage}
    />
  );
}
