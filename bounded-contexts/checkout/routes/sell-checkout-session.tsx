import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  createCheckoutRequestApiClient,
  type CheckoutSellListLineRow,
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

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.sellCheckoutSession.meta.title"),
    description: t("checkout.routes.sellCheckoutSession.meta.description"),
  });

type GuestSellCheckoutLoaderData = Readonly<{
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: GuestSellCheckoutRecovery | null;
  defaultValues: GuestSellCheckoutFormValues;
}>;

const unsupportedShipFromStates = new Set(["AA", "AE", "AP", "AS", "FM", "GU", "MH", "MP", "PR", "PW", "VI"]);

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function normalizeQueryText(searchParams: URLSearchParams, name: string) {
  return searchParams.get(name)?.trim() ?? "";
}

function defaultValuesFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutFormValues {
  return {
    ...guestSellCheckoutDefaultValues,
    payoutState: normalizeQueryText(searchParams, "payoutState") || guestSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeQueryText(searchParams, "payoutEstimateState") || guestSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeQueryText(searchParams, "riskState") || guestSellCheckoutDefaultValues.riskState,
    labelState: normalizeQueryText(searchParams, "labelState") || guestSellCheckoutDefaultValues.labelState,
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

function hasFieldErrors(errors: GuestSellCheckoutFieldErrors) {
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
      sessionId,
      lines: [],
      readiness: null,
      recovery: { kind: "empty-sell-list" },
    };
  }

  if (!provided.readinessSnapshotId || !provided.readinessSourceRevision) {
    return {
      sessionId,
      lines: sellList.items,
      readiness: null,
      recovery: { kind: "readiness-required" },
    };
  }

  const readinessResult = await api.createGuestSellListReadiness(anonymousSellListId).catch(() => null);
  if (!readinessResult?.readiness) {
    return {
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
      sessionId,
      lines: sellList.items,
      readiness,
      recovery: { kind: "readiness-blocked" },
    };
  }

  return {
    sessionId,
    lines: filterIncludedLines(sellList.items, readiness),
    readiness,
    recovery: null,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<GuestSellCheckoutLoaderData> {
  const url = new URL(request.url);
  const sessionId = params.sessionId ?? createId("chk");
  const defaultValues = defaultValuesFromSearchParams(url.searchParams);
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

export async function action({ request, params }: ActionFunctionArgs): Promise<GuestSellCheckoutActionState> {
  const formData = await request.formData();
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

  return <GuestSellCheckoutPage {...loaderData} actionState={actionState} />;
}
