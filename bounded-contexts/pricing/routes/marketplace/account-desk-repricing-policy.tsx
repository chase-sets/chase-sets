import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../support/request-support/api-client";
import type { RepricingActivityFilter } from "../../features/repricing-engine/api/activity";
import { repricingActivityFilterOrder } from "../../features/repricing-policies/ui/activity-copy";
import { PricingRepricingPolicyDetailPage } from "../../features/repricing-policies/ui/policy-detail-page";
import { repricingPolicyHref, type RepricingHaltState } from "../../features/repricing-policies/ui/policy-list-page";
import { loadOrUnavailable, REPRICING_DESK_HREF, repricingPolicyIdFrom } from "./account-desk-repricing";

const releasedHalt: RepricingHaltState = { engaged: false, engagedAt: null, releasedAt: null };

export function repricingActivityFilterFrom(value: string | null): RepricingActivityFilter | null {
  return repricingActivityFilterOrder.find((filter) => filter === value) ?? null;
}

async function loadPolicy(api: ReturnType<typeof createPricingRequestApiClient>, policyId: string) {
  try {
    return await api.getRepricingPolicy(policyId);
  } catch (error) {
    if (error instanceof PricingApiError && error.status === 404) {
      throw new Response(null, { status: 404 });
    }
    throw error;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  const policyId = params.policyId ?? "";
  const api = createPricingRequestApiClient(request);
  const search = new URL(request.url).searchParams;
  const activityFilter = repricingActivityFilterFrom(search.get("filter"));
  const after = search.get("after") || undefined;

  const [policy, halt, budget, activity] = await Promise.all([
    loadPolicy(api, policyId),
    loadOrUnavailable(() => api.getRepricingHalt()),
    loadOrUnavailable(() => api.getRepricingBudget()),
    loadOrUnavailable(() => api.listRepricingActivity(policyId, { filter: activityFilter ?? undefined, after })),
  ]);

  return {
    policy,
    halt: halt ?? releasedHalt,
    changesUsedToday: budget?.changesUsed ?? 0,
    activity,
    activityFilter,
    activityLoadFailed: activity === null,
  };
}

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    "pause-policy": async ({ request, formData }) => {
      const policyId = repricingPolicyIdFrom(formData);
      await createPricingRequestApiClient(request).pauseRepricingPolicy(policyId);
      return formActionRedirect(null, repricingPolicyHref(policyId));
    },
    "resume-policy": async ({ request, formData }) => {
      const policyId = repricingPolicyIdFrom(formData);
      await createPricingRequestApiClient(request).resumeRepricingPolicy(policyId);
      return formActionRedirect(null, repricingPolicyHref(policyId));
    },
    "delete-policy": async ({ request, formData }) => {
      await createPricingRequestApiClient(request).deleteRepricingPolicy(repricingPolicyIdFrom(formData));
      return formActionRedirect(null, REPRICING_DESK_HREF);
    },
    "engage-halt": async ({ request, formData }) => {
      await createPricingRequestApiClient(request).setRepricingHalt(true);
      return formActionRedirect(null, repricingPolicyHref(repricingPolicyIdFrom(formData)));
    },
    "release-halt": async ({ request, formData }) => {
      await createPricingRequestApiClient(request).setRepricingHalt(false);
      return formActionRedirect(null, repricingPolicyHref(repricingPolicyIdFrom(formData)));
    },
  },
  onUnknownIntent: () => ({ error: t("pricing.routes.marketplace.accountDeskRepricing.unknownAction") }),
  onError: () => ({ error: t("pricing.routes.marketplace.accountDeskRepricing.actionFailed") }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountDeskRepricing.policy.meta.title"),
    description: t("pricing.routes.marketplace.accountDeskRepricing.meta.description"),
  });

export default function MarketplaceSellerDeskRepricingPolicyRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [, setSearchParams] = useSearchParams();
  const policyId = data.policy.policyId ?? "";
  const submitIntent = (intent: string) => submit({ intent, policyId }, { method: "post" });
  const navigating = navigation.state === "loading" && !navigation.formData;

  return (
    <PricingRepricingPolicyDetailPage
      policy={data.policy}
      halt={data.halt}
      changesUsedToday={data.changesUsedToday}
      activity={data.activity}
      activityFilter={data.activityFilter}
      activityLoading={navigating}
      activityLoadFailed={data.activityLoadFailed}
      errorMessage={actionData && "error" in actionData ? String(actionData.error ?? "") : null}
      busy={navigation.state === "submitting"}
      onHaltChange={(engaged) => submitIntent(engaged ? "engage-halt" : "release-halt")}
      onPause={() => submitIntent("pause-policy")}
      onResume={() => submitIntent("resume-policy")}
      onDelete={() => submitIntent("delete-policy")}
      onActivityFilterChange={(filter) => setSearchParams(filter ? { filter } : {})}
      onActivityNext={(cursor) =>
        setSearchParams(data.activityFilter ? { filter: data.activityFilter, after: cursor } : { after: cursor })
      }
    />
  );
}
