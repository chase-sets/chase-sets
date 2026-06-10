import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createIdentityRequestApiClient, type ShippingAddress } from "@chase-sets/identity/server";
import { createSettlementRequestApiClient, type SettlementPayoutReadinessRow } from "@chase-sets/settlement/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  createCheckoutRequestApiClient,
  type CheckoutSellListLineRow,
  type SellListReadinessDecisionInput,
  type SellListReadinessSnapshot,
} from "../support/request-support/api-client";
import { readAnonymousSellListId } from "../support/request-support/guest-checkout";
import {
  GuestSellCheckoutPage,
  guestSellCheckoutDefaultValues,
  type GuestSellCheckoutActionState,
  type GuestSellCheckoutFieldErrors,
  type GuestSellCheckoutFormValues,
  type GuestSellCheckoutRecovery,
} from "../features/sell-list/ui/guest-sell-checkout-page";
import {
  SignedInSellCheckoutPage,
  signedInSellCheckoutDefaultValues,
  type SignedInSellCheckoutActionState,
  type SignedInSellCheckoutFieldErrors,
  type SignedInSellCheckoutFormValues,
  type SignedInSellCheckoutPayoutSummary,
  type SignedInSellCheckoutRecovery,
  type SignedInSellCheckoutShipFromAddress,
} from "../features/sell-list/ui/signed-in-sell-checkout-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.sellCheckoutSession.meta.title"),
    description: t("checkout.routes.sellCheckoutSession.meta.description"),
  });

type GuestSellCheckoutLoaderData = Readonly<{
  mode: "guest";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: GuestSellCheckoutRecovery | null;
  defaultValues: GuestSellCheckoutFormValues;
}>;

type SignedInSellCheckoutLoaderData = Readonly<{
  mode: "signed-in";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: SignedInSellCheckoutRecovery | null;
  defaultValues: SignedInSellCheckoutFormValues;
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[];
  payoutSummary: SignedInSellCheckoutPayoutSummary | null;
  readinessDecisions: string;
  sellListReviewPlan: string;
}>;

type SellCheckoutLoaderData = GuestSellCheckoutLoaderData | SignedInSellCheckoutLoaderData;

const unsupportedShipFromStates = new Set(["AA", "AE", "AP", "AS", "FM", "GU", "MH", "MP", "PR", "PW", "VI"]);

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function normalizeQueryText(searchParams: URLSearchParams, name: string) {
  return searchParams.get(name)?.trim() ?? "";
}

function guestDefaultValuesFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutFormValues {
  return {
    ...guestSellCheckoutDefaultValues,
    payoutState: normalizeQueryText(searchParams, "payoutState") || guestSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeQueryText(searchParams, "payoutEstimateState") || guestSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeQueryText(searchParams, "riskState") || guestSellCheckoutDefaultValues.riskState,
    labelState: normalizeQueryText(searchParams, "labelState") || guestSellCheckoutDefaultValues.labelState,
  };
}

function signedInDefaultStateFromSearchParams(searchParams: URLSearchParams) {
  return {
    payoutState: normalizeQueryText(searchParams, "payoutState") || signedInSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeQueryText(searchParams, "payoutEstimateState") || signedInSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeQueryText(searchParams, "riskState") || signedInSellCheckoutDefaultValues.riskState,
    labelState: normalizeQueryText(searchParams, "labelState") || signedInSellCheckoutDefaultValues.labelState,
    sellerReadinessState:
      normalizeQueryText(searchParams, "sellerReadinessState") ||
      signedInSellCheckoutDefaultValues.sellerReadinessState,
  };
}

function recoveryFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

function signedInRecoveryFromSearchParams(searchParams: URLSearchParams): SignedInSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "access-required" ||
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

function canUseSignedInSellCheckout(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !(actor.permissions ?? []).includes("guest-checkout.manage"));
}

type ParsedSellListLineAction = NonNullable<SellListReadinessDecisionInput["lineActions"]>[number];
type ParsedSellListLineOutcome = NonNullable<SellListReadinessDecisionInput["lineOutcomes"]>[number];

function parseSellListReadinessDecisions(value: string): SellListReadinessDecisionInput {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as {
      lineActions?: unknown;
      lineOutcomes?: unknown;
    };
    const lineActions = Array.isArray(parsed.lineActions)
      ? parsed.lineActions
          .map((action) => {
            if (!action || typeof action !== "object") {
              return null;
            }
            const lineId = String((action as { lineId?: unknown }).lineId ?? "").trim();
            const actionValue = String((action as { action?: unknown }).action ?? "").trim();
            if (
              !lineId ||
              (actionValue !== "selected-offer" && actionValue !== "smart-match" && actionValue !== "fallback-listing")
            ) {
              return null;
            }
            return { lineId, action: actionValue };
          })
          .filter((action): action is ParsedSellListLineAction => Boolean(action))
      : [];
    const lineOutcomes = Array.isArray(parsed.lineOutcomes)
      ? parsed.lineOutcomes
          .map((outcome) => {
            if (!outcome || typeof outcome !== "object") {
              return null;
            }
            const lineId = String((outcome as { lineId?: unknown }).lineId ?? "").trim();
            const outcomeValue = String((outcome as { outcome?: unknown }).outcome ?? "").trim();
            if (!lineId || outcomeValue !== "keep-in-list") {
              return null;
            }
            return { lineId, outcome: outcomeValue };
          })
          .filter((outcome): outcome is ParsedSellListLineOutcome => Boolean(outcome))
      : [];

    return { lineActions, lineOutcomes };
  } catch {
    return {};
  }
}

function encodeSellListReadinessDecisions(decisions: SellListReadinessDecisionInput) {
  return JSON.stringify({
    lineActions: decisions.lineActions ?? [],
    lineOutcomes: decisions.lineOutcomes ?? [],
  });
}

function valuesFromFormData(formData: FormData): GuestSellCheckoutFormValues {
  return {
    sellerName: normalizeText(formData.get("sellerName")),
    email: normalizeText(formData.get("email")).toLowerCase(),
    phone: normalizeText(formData.get("phone")),
    shipFromName: normalizeText(formData.get("shipFromName")),
    company: normalizeText(formData.get("company")),
    shipFromLine1: normalizeText(formData.get("shipFromLine1")),
    shipFromLine2: normalizeText(formData.get("shipFromLine2")),
    shipFromCity: normalizeText(formData.get("shipFromCity")),
    shipFromState: normalizeText(formData.get("shipFromState")).toUpperCase(),
    shipFromPostalCode: normalizeText(formData.get("shipFromPostalCode")),
    shipFromCountry: (normalizeText(formData.get("shipFromCountry")) || "US").toUpperCase(),
    payoutHandoff: normalizeText(formData.get("payoutHandoff")),
    labelPreference: normalizeText(formData.get("labelPreference")),
    termsAccepted: formData.get("termsAccepted") === "accepted",
    payoutState: normalizeText(formData.get("payoutState")) || guestSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeText(formData.get("payoutEstimateState")) || guestSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeText(formData.get("riskState")) || guestSellCheckoutDefaultValues.riskState,
    labelState: normalizeText(formData.get("labelState")) || guestSellCheckoutDefaultValues.labelState,
  };
}

function signedInValuesFromFormData(formData: FormData): SignedInSellCheckoutFormValues {
  return {
    sellerName: normalizeText(formData.get("sellerName")),
    email: normalizeText(formData.get("email")).toLowerCase(),
    phone: normalizeText(formData.get("phone")),
    shipFromAddressId: normalizeText(formData.get("shipFromAddressId")) || "__manual",
    shipFromName: normalizeText(formData.get("shipFromName")),
    company: normalizeText(formData.get("company")),
    shipFromLine1: normalizeText(formData.get("shipFromLine1")),
    shipFromLine2: normalizeText(formData.get("shipFromLine2")),
    shipFromCity: normalizeText(formData.get("shipFromCity")),
    shipFromState: normalizeText(formData.get("shipFromState")).toUpperCase(),
    shipFromPostalCode: normalizeText(formData.get("shipFromPostalCode")),
    shipFromCountry: (normalizeText(formData.get("shipFromCountry")) || "US").toUpperCase(),
    payoutMethod: normalizeText(formData.get("payoutMethod")) || signedInSellCheckoutDefaultValues.payoutMethod,
    labelPreference: normalizeText(formData.get("labelPreference")),
    termsAccepted: formData.get("termsAccepted") === "accepted",
    payoutState: normalizeText(formData.get("payoutState")) || signedInSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeText(formData.get("payoutEstimateState")) || signedInSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeText(formData.get("riskState")) || signedInSellCheckoutDefaultValues.riskState,
    labelState: normalizeText(formData.get("labelState")) || signedInSellCheckoutDefaultValues.labelState,
    sellerReadinessState:
      normalizeText(formData.get("sellerReadinessState")) || signedInSellCheckoutDefaultValues.sellerReadinessState,
  };
}

function applySelectedSavedShipFromAddress(
  values: SignedInSellCheckoutFormValues,
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[],
): SignedInSellCheckoutFormValues {
  if (values.shipFromAddressId === "__manual") {
    return values;
  }

  const savedAddress = savedShipFromAddresses.find((address) => address.shippingAddressId === values.shipFromAddressId);
  if (!savedAddress) {
    return values;
  }

  return {
    ...values,
    shipFromName: savedAddress.name,
    company: savedAddress.company,
    shipFromLine1: savedAddress.line1,
    shipFromLine2: savedAddress.line2,
    shipFromCity: savedAddress.city,
    shipFromState: savedAddress.state,
    shipFromPostalCode: savedAddress.postalCode,
    shipFromCountry: savedAddress.country,
  };
}

function validateGuestSellCheckoutValues(values: GuestSellCheckoutFormValues): GuestSellCheckoutFieldErrors {
  const errors: GuestSellCheckoutFieldErrors = {};

  if (!values.sellerName) {
    errors.sellerName = t("checkout.routes.sellCheckoutSession.validation.seller.name.required");
  }
  if (!values.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.email = t("checkout.routes.sellCheckoutSession.validation.email.required");
  }
  if (!values.shipFromName) {
    errors.shipFromName = t("checkout.routes.sellCheckoutSession.validation.ship.from.name.required");
  }
  if (!values.shipFromLine1) {
    errors.shipFromLine1 = t("checkout.routes.sellCheckoutSession.validation.address.line1.required");
  }
  if (!values.shipFromCity) {
    errors.shipFromCity = t("checkout.routes.sellCheckoutSession.validation.city.required");
  }
  if (!values.shipFromState) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.required");
  } else if (unsupportedShipFromStates.has(values.shipFromState)) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.unsupported");
  }
  if (!values.shipFromPostalCode) {
    errors.shipFromPostalCode = t("checkout.routes.sellCheckoutSession.validation.postal.code.required");
  }
  if (values.shipFromCountry !== "US") {
    errors.shipFromCountry = t("checkout.routes.sellCheckoutSession.validation.country.unsupported");
  }
  if (values.payoutHandoff !== "create-account") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.handoff.required");
  }
  if (values.labelPreference !== "prepaid-label" && values.labelPreference !== "seller-label-later") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.preference.required");
  }
  if (!values.termsAccepted) {
    errors.termsAccepted = t("checkout.routes.sellCheckoutSession.validation.terms.required");
  }
  if (values.payoutState === "setup-required") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.setup.required");
  } else if (values.payoutState === "failed") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.failed");
  }
  if (values.payoutEstimateState === "changed") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.payout.changed");
  }
  if (values.riskState === "hold") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.hold");
  } else if (values.riskState === "block") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.block");
  }
  if (values.labelState === "failed") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.failed");
  }

  return errors;
}

function validateSignedInSellCheckoutValues(values: SignedInSellCheckoutFormValues): SignedInSellCheckoutFieldErrors {
  const errors: SignedInSellCheckoutFieldErrors = {};

  if (!values.sellerName) {
    errors.sellerName = t("checkout.routes.sellCheckoutSession.validation.seller.name.required");
  }
  if (!values.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.email = t("checkout.routes.sellCheckoutSession.validation.email.required");
  }
  if (!values.shipFromName) {
    errors.shipFromName = t("checkout.routes.sellCheckoutSession.validation.ship.from.name.required");
  }
  if (!values.shipFromLine1) {
    errors.shipFromLine1 = t("checkout.routes.sellCheckoutSession.validation.address.line1.required");
  }
  if (!values.shipFromCity) {
    errors.shipFromCity = t("checkout.routes.sellCheckoutSession.validation.city.required");
  }
  if (!values.shipFromState) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.required");
  } else if (unsupportedShipFromStates.has(values.shipFromState)) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.signed.in.state.unsupported");
  }
  if (!values.shipFromPostalCode) {
    errors.shipFromPostalCode = t("checkout.routes.sellCheckoutSession.validation.postal.code.required");
  }
  if (values.shipFromCountry !== "US") {
    errors.shipFromCountry = t("checkout.routes.sellCheckoutSession.validation.signed.in.country.unsupported");
  }
  if (values.payoutMethod !== "saved-payout" && values.payoutMethod !== "setup-payout") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.method.required");
  }
  if (values.labelPreference !== "prepaid-label" && values.labelPreference !== "seller-label-later") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.preference.required");
  }
  if (!values.termsAccepted) {
    errors.termsAccepted = t("checkout.routes.sellCheckoutSession.validation.terms.required");
  }
  if (values.payoutState === "setup-required") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.setup.required");
  } else if (values.payoutState === "failed") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.failed");
  }
  if (values.payoutEstimateState === "changed") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.payout.changed");
  }
  if (values.riskState === "hold") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.hold");
  } else if (values.riskState === "block") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.block");
  }
  if (values.labelState === "failed") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.failed");
  }
  if (values.sellerReadinessState !== "ready") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.seller.readiness.failed");
  }

  return errors;
}

function hasFieldErrors(errors: GuestSellCheckoutFieldErrors | SignedInSellCheckoutFieldErrors) {
  return Object.keys(errors).length > 0;
}

function filterIncludedLines(lines: readonly CheckoutSellListLineRow[], readiness: SellListReadinessSnapshot) {
  const includedLineIds = new Set(readiness.includedLineIds);
  return lines.filter((line) => includedLineIds.has(line.line_id));
}

function sideEffectsNotAttempted() {
  return {
    label: "not-attempted",
    payout: "not-attempted",
    sale: "not-attempted",
    notification: "not-attempted",
    accountHistory: "not-attempted",
  } as const;
}

async function loadSavedShipFromAddresses(
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

async function loadPayoutSummary(request: Request): Promise<SignedInSellCheckoutPayoutSummary> {
  let readiness: SettlementPayoutReadinessRow;
  try {
    readiness = await createSettlementRequestApiClient(request).getPayoutReadiness();
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

async function loadGuestSellCheckoutState(
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

async function loadSignedInSellCheckoutState(
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

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<GuestSellCheckoutActionState | SignedInSellCheckoutActionState> {
  const formData = await request.formData();
  const actor = await resolveActorFromAuthApi({ request });
  if (canUseSignedInSellCheckout(actor)) {
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
    if (hasFieldErrors(fieldErrors)) {
      return {
        status: "error",
        values,
        fieldErrors,
      };
    }

    return {
      status: "confirmed",
      values,
      confirmation: {
        referenceId: `signed-in-sell-${state.sessionId}`,
        sellerName: values.sellerName,
        estimatedTotal: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(
          state.lines.reduce(
            (sum, line) =>
              sum + Number(line.offer_price_amount ?? line.minimum_listing_price_amount ?? 0) * line.quantity,
            0,
          ),
        ),
        sideEffects: sideEffectsNotAttempted(),
      },
    };
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

  return {
    status: "confirmed",
    values,
    confirmation: {
      referenceId: `guest-sell-${state.sessionId}`,
      sellerName: values.sellerName,
      estimatedTotal: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(
        state.lines.reduce(
          (sum, line) =>
            sum + Number(line.offer_price_amount ?? line.minimum_listing_price_amount ?? 0) * line.quantity,
          0,
        ),
      ),
      sideEffects: sideEffectsNotAttempted(),
    },
  };
}

export default function GuestSellCheckoutRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionState = useActionData<typeof action>() ?? { status: "idle" as const };

  if (loaderData.mode === "signed-in") {
    return <SignedInSellCheckoutPage {...loaderData} actionState={actionState as SignedInSellCheckoutActionState} />;
  }

  return <GuestSellCheckoutPage {...loaderData} actionState={actionState as GuestSellCheckoutActionState} />;
}
