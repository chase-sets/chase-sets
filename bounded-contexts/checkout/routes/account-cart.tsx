import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  evaluatePostWriteHandoff,
  loadFreshlyWrittenResource,
  postWriteRecoveryKindForFreshWriteReadError,
  postWriteRecoveryKindForHandoffState,
  readPostWriteHandoffState,
  recoverFreshWriteReadError,
  type PostWriteRecoveryKind,
  type PostWriteHandoffState,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import {
  navigateAfterWriteFromSourcesWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
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
  isEmptyAccountCartAddLineHandoff,
  isPendingAccountCartAddLineHandoff,
} from "../support/request-support/account-cart-handoffs";
import { CheckoutCartPage } from "../features/cart/ui/cart-page";
import { usePendingFreshWriteRevalidation } from "../support/route-support/pending-fresh-write-revalidation";

const MARKETPLACE_DESCRIPTION = t("checkout.routes.accountCart.review.cart.lines.adjust.quantity.and");

function canUseAccountCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

async function writeCartCommandsInOrder(writes: readonly (() => Promise<unknown>)[]) {
  const results: unknown[] = [];
  for (const write of writes) {
    results.push(await write());
  }
  return results;
}

async function redirectToFreshAccountCart(writeResults: readonly unknown[]) {
  return redirect(await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(writeResults, "/account/cart"));
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

function isExpiredAccountCartAddLineHandoff(
  state: PostWriteHandoffState,
): state is Extract<PostWriteHandoffState, { kind: "not-fresh-write" }> {
  return (
    state.kind === "not-fresh-write" &&
    state.freshWrite.kind === "expired" &&
    isAccountCartAddLineHandoff(state.handoff)
  );
}

function isTransientCartReadError(error: unknown) {
  const status = checkoutApiErrorStatus(error);
  const code = checkoutApiErrorCode(error);

  return (
    status === 404 ||
    (status === 503 && code === "projection_freshness_timeout") ||
    ((status === 502 || status === 503 || status === 504) && !code)
  );
}

function pendingCartRecovery<TCart>(cart: TCart | null, message: string, recoveryKind: PostWriteRecoveryKind) {
  return {
    cart,
    cartRecovery: {
      kind: "pending-fresh-write" as const,
      recoveryKind,
      message,
    },
  };
}

function missingCartRecovery<TCart>(cart: TCart | null, recoveryKind: PostWriteRecoveryKind) {
  return {
    cart,
    cartRecovery: {
      kind: "missing-after-fresh-write" as const,
      recoveryKind,
      message: t("checkout.routes.accountCart.cart.missing.after.fresh.write"),
    },
  };
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
      if (
        isExpiredAccountCartAddLineHandoff(handoff.state) &&
        isEmptyAccountCartAddLineHandoff(cart, handoff.state.handoff)
      ) {
        recordAccountCartSemanticHandoffOutcome(
          actorMode,
          "handoff_expired",
          freshnessOutcomeForHandoffState(handoffState),
          "action_required",
        );
        return missingCartRecovery(cart, postWriteRecoveryKindForHandoffState(handoff.state));
      }

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
      return pendingCartRecovery(
        cart,
        t("checkout.routes.accountCart.adding.item.description"),
        postWriteRecoveryKindForHandoffState(handoffState),
      );
    } else {
      recordAccountCartSemanticHandoffOutcome(
        actorMode,
        "handoff_satisfied",
        freshnessOutcomeForHandoffState(handoffState),
        "none",
      );
    }

    return { cart, cartRecovery: null };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: checkoutApiErrorStatus,
      getErrorCode: checkoutApiErrorCode,
      getBody: checkoutApiErrorBody,
      recoverTransient: (classification) => ({
        cart: null,
        cartRecovery: {
          kind: "pending-fresh-write" as const,
          recoveryKind: postWriteRecoveryKindForFreshWriteReadError(classification),
          message: t("checkout.routes.accountCart.cart.pending.fresh.write"),
        },
      }),
    });
    if (recovery) {
      return recovery;
    }

    const handoffState = readPostWriteHandoffState(request);
    if (isExpiredAccountCartAddLineHandoff(handoffState) && isTransientCartReadError(error)) {
      recordAccountCartSemanticHandoffOutcome(
        actorMode,
        "handoff_expired",
        freshnessOutcomeForHandoffState(handoffState),
        "action_required",
      );
      return missingCartRecovery<TCart>(null, postWriteRecoveryKindForHandoffState(handoffState));
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
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const api = createCheckoutRequestApiClient(resolvedRequest);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });

  if (!canUseAccountCart(actor)) {
    return loadCartWithPostWriteRecovery(
      resolvedRequest,
      () => api.getGuestCart(readAnonymousCartId(resolvedRequest)),
      "guest",
    );
  }

  return loadCartWithPostWriteRecovery(resolvedRequest, () => api.getCart(), "account");
}

async function handleAction(intent: string, { request, formData }: FormActionContext) {
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
        const results = await writeCartCommandsInOrder([
          () =>
            api.updateGuestCartLineQuantity(anonymousCartId, primaryLineId ?? "", {
              quantity: nextQuantity,
            }),
          ...duplicateLineIds.map((lineId) => () => api.removeGuestCartLine(anonymousCartId, lineId)),
        ]);
        return await redirectToFreshAccountCart(results);
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await writeCartCommandsInOrder([
        () =>
          api.updateCartLineQuantity(primaryLineId ?? "", {
            quantity: nextQuantity,
          }),
        ...duplicateLineIds.map((lineId) => () => api.removeCartLine(lineId)),
      ]);
      return await redirectToFreshAccountCart(results);
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
        const results = await writeCartCommandsInOrder(
          lineIds.map((lineId) => () => api.updateGuestCartLineFulfillment(anonymousCartId, lineId, fulfillment)),
        );
        return await redirectToFreshAccountCart(results);
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await writeCartCommandsInOrder(
        lineIds.map((lineId) => () => api.updateCartLineFulfillment(lineId, fulfillment)),
      );
      return await redirectToFreshAccountCart(results);
    }

    if (intent === "remove-cart-line") {
      const lineIds = cartLineIdsFromForm(formData);

      if (!useAccountCart && anonymousCartId) {
        const results = await writeCartCommandsInOrder(
          lineIds.map((lineId) => () => api.removeGuestCartLine(anonymousCartId, lineId)),
        );
        return await redirectToFreshAccountCart(results);
      }

      if (!useAccountCart) {
        throw new Error(t("checkout.routes.accountCart.request.failed"));
      }

      const results = await writeCartCommandsInOrder(lineIds.map((lineId) => () => api.removeCartLine(lineId)));
      return await redirectToFreshAccountCart(results);
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("checkout.routes.accountCart.request.failed"),
    };
  }
}

export const action = defineFormAction({
  readIntent: (formData, intentField) => String(formData.getAll(intentField).at(-1) ?? ""),
  intents: {
    "update-cart-line": (context) => handleAction("update-cart-line", context),
    "lock-preferred-listing": (context) => handleAction("lock-preferred-listing", context),
    "remove-cart-line": (context) => handleAction("remove-cart-line", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.accountCart.cart.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutAccountCartRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const cartRecovery = "cartRecovery" in data ? data.cartRecovery : null;
  const { currentPath, isAutoRevalidating } = usePendingFreshWriteRevalidation(
    cartRecovery?.kind === "pending-fresh-write",
  );

  return (
    <CheckoutCartPage
      cartLines={data.cart?.items ?? []}
      errorMessage={actionData?.error ?? null}
      recoveryState={
        cartRecovery
          ? cartRecovery.kind === "pending-fresh-write"
            ? {
                ...cartRecovery,
                refreshHref: currentPath,
                isAutoRevalidating,
              }
            : {
                ...cartRecovery,
                refreshHref: currentPath,
              }
          : null
      }
    />
  );
}
