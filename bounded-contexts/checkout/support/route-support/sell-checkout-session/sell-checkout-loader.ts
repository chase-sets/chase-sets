import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createId } from "@chase-sets/primitives/typed-ids";
import { redirect, type LoaderFunctionArgs } from "react-router";
import {
  createCheckoutRequestApiClient,
  type CheckoutSellPayoutReadinessRow,
  type CheckoutShipFromAddressRow,
} from "../../request-support/api-client";
import { readAnonymousSellListId } from "../../request-support/guest-checkout";
import { guestSellCheckoutDefaultValues } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import { signedInSellCheckoutDefaultValues } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
  SignedInSellCheckoutShipFromAddress,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import { normalizeQueryText } from "./sell-checkout-form";
import {
  filterIncludedLines,
  recoveryFromSearchParams,
  signedInRecoveryFromSearchParams,
  confirmationIdForSession,
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
    const response = await createCheckoutRequestApiClient(request).listSellListShipFromAddresses();
    return response.items.map(shipFromAddressFromRow);
  } catch {
    return [];
  }
}

function shipFromAddressFromRow(row: CheckoutShipFromAddressRow): SignedInSellCheckoutShipFromAddress {
  return {
    shippingAddressId: row.shipping_address_id,
    label: row.label,
    name: row.recipient_name,
    company: row.company ?? "",
    line1: row.line1,
    line2: row.line2 ?? "",
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    phone: row.phone ?? "",
    email: row.email ?? "",
    isDefault: row.is_default,
  };
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
): SignedInSellCheckoutFormValues {
  const defaultAddress =
    savedShipFromAddresses.find((address) => address.isDefault) ?? savedShipFromAddresses[0] ?? null;
  return {
    ...signedInSellCheckoutDefaultValues,
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
    readinessDecisions: {},
    reviewPlan: null,
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

  const readinessResult = await api
    .createSellListReadiness({
      readinessSnapshotId: provided.readinessSnapshotId,
      readinessSourceRevision: provided.readinessSourceRevision,
      confirmationId: confirmationIdForSession(sessionId),
    })
    .catch(() => null);
  if (!readinessResult?.readiness || !readinessResult.reviewPlan || !readinessResult.decisions) {
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
    reviewPlan: readinessResult.reviewPlan,
    readinessDecisions: readinessResult.decisions,
    recovery: null,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<SellCheckoutLoaderData> {
  const url = new URL(request.url);
  const sessionId = params.sessionId ?? createId("chk");
  const actor = await resolveActorFromAuthApi({ request });

  if (canUseSignedInSellCheckout(actor)) {
    const forcedRecovery = signedInRecoveryFromSearchParams(url.searchParams);
    const state = await loadSignedInSellCheckoutState(request, sessionId, {
      readinessSnapshotId: normalizeQueryText(url.searchParams, "readinessSnapshotId"),
      readinessSourceRevision: normalizeQueryText(url.searchParams, "readinessSourceRevision"),
    });

    return {
      ...state,
      recovery: forcedRecovery ?? state.recovery,
      defaultValues: signedInDefaultsFromFacts(state.savedShipFromAddresses),
    };
  }

  const forcedRecovery = recoveryFromSearchParams(url.searchParams);
  const state = await loadGuestSellCheckoutState(request, sessionId, {
    readinessSnapshotId: normalizeQueryText(url.searchParams, "readinessSnapshotId"),
    readinessSourceRevision: normalizeQueryText(url.searchParams, "readinessSourceRevision"),
  });

  return {
    ...state,
    recovery: forcedRecovery ?? state.recovery,
    defaultValues: guestSellCheckoutDefaultValues,
  };
}
