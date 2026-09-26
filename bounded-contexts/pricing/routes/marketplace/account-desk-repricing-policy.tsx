import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useNavigation, useSearchParams, useSubmit } from "react-router";
import {
  defineFormAction,
  formActionRedirect,
  loadAfterWrite,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../support/request-support/api-client";
import type { RepricingActivityFilter } from "../../features/repricing-engine/api/activity";
import { repricingActivityFilterOrder } from "../../features/repricing-policies/ui/activity-copy";
import {
  PricingRepricingPolicyCatchingUpPage,
  PricingRepricingPolicyDetailPage,
} from "../../features/repricing-policies/ui/policy-detail-page";
import { repricingPolicyHref, type RepricingHaltState } from "../../features/repricing-policies/ui/policy-list-page";
import {
  repricingDeskRequestWithoutFreshWrite,
  resolveRepricingDeskPostWriteRequest,
} from "../../support/route-support/repricing-desk-post-write";
import { loadOrUnavailable, REPRICING_DESK_HREF, repricingPolicyIdFrom } from "./account-desk-repricing";

const releasedHalt: RepricingHaltState = { engaged: false, engagedAt: null, releasedAt: null };

export function repricingActivityFilterFrom(value: string | null): RepricingActivityFilter | null {
  return repricingActivityFilterOrder.find((filter) => filter === value) ?? null;
}

const REPRICING_POLICY_POST_WRITE_TELEMETRY = {
  boundedContextName: "pricing",
  surface: "account-desk-repricing-policy",
  routeId: "account-desk-repricing-policy",
  routeTemplate: "/account/desk/repricing/:policyId",
} as const satisfies PlatformPostWriteTelemetry;

async function navigateAfterPolicyWrite(commandResult: unknown, destination: string) {
  return redirect(
    await navigateAfterWriteWithPlatformPostWriteToken(commandResult, destination, {
      telemetry: REPRICING_POLICY_POST_WRITE_TELEMETRY,
    }),
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  const policyId = params.policyId ?? "";
  const resolvedRequest = await resolveRepricingDeskPostWriteRequest(request);
  const api = createPricingRequestApiClient(resolvedRequest);
  const ancillaryApi = createPricingRequestApiClient(repricingDeskRequestWithoutFreshWrite(resolvedRequest));
  const search = new URL(request.url).searchParams;
  const activityFilter = repricingActivityFilterFrom(search.get("filter"));
  const after = search.get("after") || undefined;

  // The ancillary reads start alongside the policy read but are consulted only
  // once the policy resolves, so a missing policy answers 404 first.
  const ancillaryReads = Promise.all([
    loadOrUnavailable(() => ancillaryApi.getRepricingHalt()),
    loadOrUnavailable(() => ancillaryApi.getRepricingBudget()),
    loadOrUnavailable(() =>
      ancillaryApi.listRepricingActivity(policyId, { filter: activityFilter ?? undefined, after }),
    ),
  ]);
  ancillaryReads.catch(() => undefined);
  const policyRead = await loadAfterWrite({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof PricingApiError && error.status === 404,
    load: () => api.getRepricingPolicy(policyId),
    telemetry: REPRICING_POLICY_POST_WRITE_TELEMETRY,
  });

  // A fresh write whose policy is still reaching the read model is bounded
  // recovery. Without a live receipt, not-found is an ordinary 404, and
  // authorization errors always propagate.
  if (policyRead.kind === "pending") {
    return { recovery: "catching-up" as const };
  }
  if (policyRead.kind === "permanent-failure") {
    const error = "error" in policyRead ? policyRead.error : null;
    if (error instanceof PricingApiError && error.status === 404) {
      throw new Response(null, { status: 404 });
    }
    throw error;
  }

  const [halt, budget, activity] = await ancillaryReads;

  return {
    recovery: null,
    policy: policyRead.data,
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
      const result = await createPricingRequestApiClient(request).pauseRepricingPolicy(policyId);
      return navigateAfterPolicyWrite(result, repricingPolicyHref(policyId));
    },
    "resume-policy": async ({ request, formData }) => {
      const policyId = repricingPolicyIdFrom(formData);
      const result = await createPricingRequestApiClient(request).resumeRepricingPolicy(policyId);
      return navigateAfterPolicyWrite(result, repricingPolicyHref(policyId));
    },
    "delete-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).deleteRepricingPolicy(repricingPolicyIdFrom(formData));
      return navigateAfterPolicyWrite(result, REPRICING_DESK_HREF);
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
  const location = useLocation();
  const submit = useSubmit();
  const [, setSearchParams] = useSearchParams();
  if (data.recovery === "catching-up") {
    return <PricingRepricingPolicyCatchingUpPage refreshHref={`${location.pathname}${location.search}`} />;
  }
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
