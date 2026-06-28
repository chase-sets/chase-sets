import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createIdentityRequestApiClient, type ShippingAddress } from "@chase-sets/identity/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import { redirect, type LoaderFunctionArgs } from "react-router";
import {
  createCheckoutRequestApiClient,
  type CheckoutSellPayoutReadinessRow,
  type SellListReadinessDecisionInput,
} from "../../request-support/api-client";
import { readAnonymousSellListId } from "../../request-support/guest-checkout";
import { signedInSellCheckoutDefaultValues } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
  SignedInSellCheckoutShipFromAddress,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import {
  guestDefaultValuesFromSearchParams,
  normalizeQueryText,
  signedInDefaultStateFromSearchParams,
} from "./sell-checkout-form";
import {
  encodeSellListReadinessDecisions,
  filterIncludedLines,
  parseSellListReadinessDecisions,
  recoveryFromSearchParams,
  signedInRecoveryFromSearchParams,
} from "./sell-checkout-readiness";
import type {
  GuestSellCheckoutLoaderData,
  SellCheckoutLoaderData,
  SignedInSellCheckoutLoaderData,
} from "./sell-checkout-types";

export function canUseSignedInSellCheckout(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !(actor.permissions ?? []).includes("guest-checkout.manage"));
}

export async function loadSavedShipFromAddresses(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
): Promise<readonly SignedInSellCheckoutShipFromAddress[]> {
  if (!actor || actor.roleKey === "guest-buyer" || !(actor.permissions ?? []).includes("accounts.view")) {
    return [];
  }

  try {
    const identityApi = createIdentityRequestApiClient(request);
    const response = await identityApi.listShippingAddresses<{ items: readonly ShippingAddress[] }>(actor.accountId);
    return response.items.map((address) => ({
      shippingAddressId: address.shipping_address_id,
      label: address.label,
      name: address.recipient_name,
      company: address.company ?? "",
      line1: address.line1,
      line2: address.line2 ?? "",
      city: address.city,
      state: address.state,
      postalCode: address.postal_code,
      country: address.country,
      phone: address.phone ?? "",
      email: address.email ?? "",
      isDefault: address.is_default,
    }));
  } catch {
    return [];
  }
}

export async function loadPayoutSummary(request: Request): Promise<SignedInSellCheckoutPayoutSummary> {
  let readiness: CheckoutSellPayoutReadinessRow;
  try {
    readiness = await createCheckoutRequestApiClient(request).getSellListPayoutReadiness();
  } catch {
    return {
      status: "unavailable",
      displayLabel: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.unavailable"),
      supportingText: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.unavailable.description"),
      missingRequirements: [],
    };
  }

  if (readiness.status === "ready") {
    return {
      status: "ready",
      displayLabel: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.ready"),
      supportingText: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.ready.description"),
      missingRequirements: [],
    };
  }

  return {
    status: readiness.status,
    displayLabel: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.needs.setup"),
    supportingText: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.needs.setup.description", {
      requirements: readiness.missing_requirements.join(", ") || readiness.status,
    }),
    missingRequirements: readiness.missing_requirements,
  };
}

function signedInDefaultsFromFacts(
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[],
  payoutSummary: SignedInSellCheckoutPayoutSummary | null,
  state: ReturnType<typeof signedInDefaultStateFromSearchParams>,
): SignedInSellCheckoutFormValues {
  const defaultAddress =
    savedShipFromAddresses.find((address) => address.isDefault) ?? savedShipFromAddresses[0] ?? null;
  const payoutState =
    state.payoutState !== signedInSellCheckoutDefaultValues.payoutState
      ? state.payoutState
      : payoutSummary?.status === "ready"
        ? "ready"
        : "setup-required";

  return {
    ...signedInSellCheckoutDefaultValues,
    ...state,
    payoutState,
    sellerName: defaultAddress?.name ?? "",
    email: defaultAddress?.email ?? "",
    phone: defaultAddress?.phone ?? "",
    shipFromAddressId: defaultAddress?.shippingAddressId ?? "__manual",
    shipFromName: defaultAddress?.name ?? "",
    company: defaultAddress?.company ?? "",
    shipFromLine1: defaultAddress?.line1 ?? "",
    shipFromLine2: defaultAddress?.line2 ?? "",
    shipFromCity: defaultAddress?.city ?? "",
    shipFromState: defaultAddress?.state ?? "",
    shipFromPostalCode: defaultAddress?.postalCode ?? "",
    shipFromCountry: defaultAddress?.country ?? "US",
  };
}

export async function loadGuestSellCheckoutState(
  request: Request,
  sessionId: string,
  provided: Readonly<{
    readinessSnapshotId: string;
    readinessSourceRevision: string;
  }>,
): Promise<Omit<GuestSellCheckoutLoaderData, "defaultValues">> {
  const anonymousSellListId = readAnonymousSellListId(request);
  if (!anonymousSellListId) {
    return {
      mode: "guest",
      sessionId,
      lines: [],
      readiness: null,
      recovery: { kind: "missing-sell-list" },
    };
  }

  const api = createCheckoutRequestApiClient(request);
  const sellList = await api.getGuestSellList(anonymousSellListId);
  if (sellList.items.length === 0) {
    return {
      mode: "guest",
      sessionId,
      lines: [],
      readiness: null,
      recovery: { kind: "empty-sell-list" },
    };
  }

  if (!provided.readinessSnapshotId || !provided.readinessSourceRevision) {
    return {
      mode: "guest",
      sessionId,
      lines: sellList.items,
      readiness: null,
      recovery: { kind: "readiness-required" },
    };
  }

  const readinessResult = await api.createGuestSellListReadiness(anonymousSellListId).catch(() => null);
  if (!readinessResult?.readiness) {
    return {
      mode: "guest",
      sessionId,
      lines: sellList.items,
      readiness: null,
      recovery: {
        kind: "readiness-stale",
        detail: t("checkout.routes.sellCheckoutSession.readiness.unavailable"),
      },
    };
  }

  const { readiness } = readinessResult;
  const valid =
    readiness.snapshotId === provided.readinessSnapshotId &&
    readiness.sourceRevision === provided.readinessSourceRevision;
  if (!valid) {
    return {
      mode: "guest",
      sessionId,
      lines: sellList.items,
      readiness,
      recovery: { kind: "readiness-stale" },
    };
  }

  if (
    readiness.status !== "ready" ||
    readiness.unresolvedLineIds.length > 0 ||
    readiness.includedLineIds.length === 0
  ) {
    return {
      mode: "guest",
      sessionId,
      lines: sellList.items,
      readiness,
      recovery: { kind: "readiness-blocked" },
    };
  }

  return {
    mode: "guest",
    sessionId,
    lines: filterIncludedLines(sellList.items, readiness),
    readiness,
    recovery: null,
  };
}

export async function loadSignedInSellCheckoutState(
  request: Request,
  sessionId: string,
  provided: Readonly<{
    readinessSnapshotId: string;
    readinessSourceRevision: string;
    readinessDecisions: SellListReadinessDecisionInput;
    readinessDecisionsJson: string;
    sellListReviewPlanJson: string;
  }>,
): Promise<Omit<SignedInSellCheckoutLoaderData, "defaultValues">> {
  const actor = await resolveActorFromAuthApi({ request });
  const savedShipFromAddresses = await loadSavedShipFromAddresses(request, actor);
  const payoutSummary = await loadPayoutSummary(request);
  const base = {
    mode: "signed-in" as const,
    sessionId,
    savedShipFromAddresses,
    payoutSummary,
    readinessDecisions: provided.readinessDecisionsJson,
    sellListReviewPlan: provided.sellListReviewPlanJson,
  };

  if (!canUseSignedInSellCheckout(actor)) {
    return {
      ...base,
      lines: [],
      readiness: null,
      recovery: { kind: "access-required" },
    };
  }

  const api = createCheckoutRequestApiClient(request);
  const sellList = await api.getSellList();
  if (sellList.items.length === 0) {
    return {
      ...base,
      lines: [],
      readiness: null,
      recovery: { kind: "empty-sell-list" },
    };
  }

  if (!provided.readinessSnapshotId || !provided.readinessSourceRevision) {
    return {
      ...base,
      lines: sellList.items,
      readiness: null,
      recovery: { kind: "readiness-required" },
    };
  }

  const readinessResult = await api.createSellListReadiness(provided.readinessDecisions).catch(() => null);
  if (!readinessResult?.readiness) {
    return {
      ...base,
      lines: sellList.items,
      readiness: null,
      recovery: {
        kind: "readiness-stale",
        detail: t("checkout.routes.sellCheckoutSession.readiness.unavailable"),
      },
    };
  }

  const { readiness } = readinessResult;
  const valid =
    readiness.snapshotId === provided.readinessSnapshotId &&
    readiness.sourceRevision === provided.readinessSourceRevision;
  if (!valid) {
    return {
      ...base,
      lines: sellList.items,
      readiness,
      recovery: { kind: "readiness-stale" },
    };
  }

  if (
    readiness.status !== "ready" ||
    readiness.unresolvedLineIds.length > 0 ||
    readiness.includedLineIds.length === 0
  ) {
    return {
      ...base,
      lines: sellList.items,
      readiness,
      recovery: { kind: "readiness-blocked" },
    };
  }

  return {
    ...base,
    lines: filterIncludedLines(sellList.items, readiness),
    readiness,
    recovery: null,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<SellCheckoutLoaderData> {
  const url = new URL(request.url);
  const sessionId = params.sessionId ?? createId("chk");
  const actor = await resolveActorFromAuthApi({ request });

  if (canUseSignedInSellCheckout(actor)) {
    const readinessDecisions = parseSellListReadinessDecisions(
      normalizeQueryText(url.searchParams, "readinessDecisions"),
    );
    const readinessDecisionsJson = encodeSellListReadinessDecisions(readinessDecisions);
    const forcedRecovery = signedInRecoveryFromSearchParams(url.searchParams);
    const state = await loadSignedInSellCheckoutState(request, sessionId, {
      readinessSnapshotId: normalizeQueryText(url.searchParams, "readinessSnapshotId"),
      readinessSourceRevision: normalizeQueryText(url.searchParams, "readinessSourceRevision"),
      readinessDecisions,
      readinessDecisionsJson,
      sellListReviewPlanJson: normalizeQueryText(url.searchParams, "sellListReviewPlan"),
    });

    return {
      ...state,
      recovery: forcedRecovery ?? state.recovery,
      defaultValues: signedInDefaultsFromFacts(
        state.savedShipFromAddresses,
        state.payoutSummary,
        signedInDefaultStateFromSearchParams(url.searchParams),
      ),
    };
  }

  const defaultValues = guestDefaultValuesFromSearchParams(url.searchParams);
  const forcedRecovery = recoveryFromSearchParams(url.searchParams);
  const state = await loadGuestSellCheckoutState(request, sessionId, {
    readinessSnapshotId: normalizeQueryText(url.searchParams, "readinessSnapshotId"),
    readinessSourceRevision: normalizeQueryText(url.searchParams, "readinessSourceRevision"),
  });

  return {
    ...state,
    recovery: forcedRecovery ?? state.recovery,
    defaultValues,
  };
}
