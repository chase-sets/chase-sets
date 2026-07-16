import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import {
  CommercialTermsHomePage,
  type CommercialTermsCreateKind,
} from "../../features/home/ui/commercial-terms-home-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../features/home/integrations/admin-api-client";
import { commercialTermsApiErrorAdapter } from "../../features/home/integrations/admin-api-error";
import { normalizeAgreementAccountIdText } from "../../features/agreements/api/account-id";
import { formatCommercialTermsAdminLoadError } from "../../features/home/integrations/admin-loader-error";
import contextManifest from "../../context.json";

function createKind(value: string | null): CommercialTermsCreateKind | null {
  return value === "schedule" || value === "agreement" ? value : null;
}

function termsBody(formData: FormData) {
  return {
    label: formData.get("label"),
    marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
    marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
    shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
    status: formData.get("status"),
    effectiveFrom: formData.get("effectiveFrom"),
    effectiveUntil: formData.get("effectiveUntil"),
  };
}

function homeQueryState(request: Request) {
  const url = new URL(request.url);
  return {
    createKind: createKind(url.searchParams.get("create")),
    initialAccountId: url.searchParams.get("account"),
  };
}

function unavailableHome(request: Request, error: unknown) {
  return {
    schedules: [],
    agreements: [],
    accounts: [],
    selectedSchedule: null,
    selectedAgreement: null,
    ...homeQueryState(request),
    loadError: formatCommercialTermsAdminLoadError(error),
  };
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "commercial-terms-home",
  errorAdapter: commercialTermsApiErrorAdapter,
  load: async ({ request }) => {
    const url = new URL(request.url);
    const api = createCommercialTermsRequestApiClient(request);
    const scheduleId = url.searchParams.get("schedule");
    const agreementId = url.searchParams.get("agreement");
    const [scheduleList, agreementList, accounts, selectedSchedule, selectedAgreement] = await Promise.all([
      api.listSchedules("limit=250&offset=0"),
      api.listAgreements("limit=250&offset=0"),
      api.listAccountOptions(),
      scheduleId ? api.getSchedule(scheduleId) : null,
      agreementId ? api.getAgreement(agreementId) : null,
    ]);
    return {
      schedules: scheduleList.items,
      agreements: agreementList.items,
      accounts,
      selectedSchedule,
      selectedAgreement,
      ...homeQueryState(request),
    };
  },
  map: (data) => ({ ...data, loadError: null as string | null }),
  onPending: (result, { request }) => unavailableHome(request, "error" in result ? result.error : null),
  onPermanentFailure: (result, { request }) => unavailableHome(request, "error" in result ? result.error : null),
  telemetry: { surface: "commercial-terms-home", routeTemplate: "/commerce/terms" },
});

export const action = defineFormAction({
  intents: {
    "create-schedule": async ({ request, formData }) => {
      const result = await createCommercialTermsRequestApiClient(request).createSchedule({
        ...termsBody(formData),
        accountType: formData.get("accountType"),
      });
      return formActionRedirect(result, `/commerce/terms?schedule=${encodeURIComponent(result.id)}`);
    },
    "revise-schedule": async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      const result = await createCommercialTermsRequestApiClient(request).updateSchedule(id, termsBody(formData));
      return formActionRedirect(result, `/commerce/terms?schedule=${encodeURIComponent(id)}`);
    },
    "create-agreement": async ({ request, formData }) => {
      const result = await createCommercialTermsRequestApiClient(request).createAgreement({
        ...termsBody(formData),
        accountId: normalizeAgreementAccountIdText(formData.get("accountId")),
      });
      return formActionRedirect(result, `/commerce/terms?agreement=${encodeURIComponent(result.id)}`);
    },
    "revise-agreement": async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      const result = await createCommercialTermsRequestApiClient(request).updateAgreement(id, termsBody(formData));
      return formActionRedirect(result, `/commerce/terms?agreement=${encodeURIComponent(id)}`);
    },
  },
  onUnknownIntent: () => ({ error: t("commercialTerms.features.home.unknownAction") }),
  onError: (error) => {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  },
});

export const meta: MetaFunction = () => [{ title: t("commercialTerms.features.home.metaTitle") }];

export default function CommercialTermsHomeRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <CommercialTermsHomePage
      schedules={data.schedules}
      agreements={data.agreements}
      accounts={data.accounts}
      selectedSchedule={data.selectedSchedule}
      selectedAgreement={data.selectedAgreement}
      createKind={data.createKind}
      initialAccountId={data.initialAccountId}
      errorMessage={actionData?.error ?? null}
      loadErrorMessage={data.loadError}
    />
  );
}
