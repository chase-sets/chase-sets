import { t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import { Button } from "@chase-sets/design-system";
import { PolicyEditorDrawer } from "../../features/repricing-policies/ui/policy-editor-drawer";
import type { PolicyEditorBody } from "../../features/repricing-policies/ui/presets";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import {
  defineFormAction,
  defineResourceRoute,
  formActionRedirect,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import {
  createPricingRequestApiClient,
  PricingApiError,
  pricingValidationMessages,
  type RepricingActivityPage,
  type RepricingPolicyState,
} from "../../support/request-support/api-client";
import { pricingApiErrorAdapter } from "../../support/request-support/route-api-error";
import { useRepricingDeskCatchUp } from "../../support/route-support/repricing-desk-catch-up";
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

type RepricingPolicyLoaderData =
  | Readonly<{ recovery: "catching-up" }>
  | Readonly<{
      recovery: null;
      policy: RepricingPolicyState;
      halt: RepricingHaltState;
      changesUsedToday: number;
      activity: RepricingActivityPage | null;
      activityFilter: RepricingActivityFilter | null;
      activityLoadFailed: boolean;
    }>;

// A fresh write whose policy is still reaching the read model is bounded
// recovery. Without a live receipt, not-found is an ordinary 404, and
// authorization errors always propagate.
export const loader = defineResourceRoute<RepricingPolicyState, RepricingPolicyLoaderData>({
  manifest: contextManifest,
  routeId: "account-desk-repricing-policy",
  prepare: async (args) => ({ ...args, request: await resolveRepricingDeskPostWriteRequest(args.request) }),
  authorization: { permission: "pricing.view" },
  errorAdapter: pricingApiErrorAdapter,
  load: ({ request, params }) => createPricingRequestApiClient(request).getRepricingPolicy(params.policyId ?? ""),
  // Halt, budget and activity reads never carry the policy receipt, and are
  // made only once the policy resolves, so a missing policy answers 404 first.
  map: async (policy, { request, params }) => {
    const api = createPricingRequestApiClient(repricingDeskRequestWithoutFreshWrite(request));
    const search = new URL(request.url).searchParams;
    const activityFilter = repricingActivityFilterFrom(search.get("filter"));
    const after = search.get("after") || undefined;
    const [halt, budget, activity] = await Promise.all([
      loadOrUnavailable(() => api.getRepricingHalt()),
      loadOrUnavailable(() => api.getRepricingBudget()),
      loadOrUnavailable(() =>
        api.listRepricingActivity(params.policyId ?? "", { filter: activityFilter ?? undefined, after }),
      ),
    ]);
    return {
      recovery: null,
      policy,
      halt: halt ?? releasedHalt,
      changesUsedToday: budget?.changesUsed ?? 0,
      activity,
      activityFilter,
      activityLoadFailed: activity === null,
    };
  },
  telemetry: REPRICING_POLICY_POST_WRITE_TELEMETRY,
  onPending: () => ({ recovery: "catching-up" as const }),
  onPermanentFailure: (result) => {
    const error = "error" in result ? result.error : null;
    if (error instanceof PricingApiError && error.status === 404) {
      throw new Response(null, { status: 404 });
    }
    throw error;
  },
});

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    "revise-policy": async ({ request, formData }) => {
      const policyId = repricingPolicyIdFrom(formData);
      const body: PolicyEditorBody = JSON.parse(String(formData.get("body") ?? "null"));
      const result = await createPricingRequestApiClient(request).reviseRepricingPolicy(policyId, body);
      return navigateAfterPolicyWrite(result, repricingPolicyHref(policyId));
    },
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
      const result = await createPricingRequestApiClient(request).deleteRepricingPolicy(
        repricingPolicyIdFrom(formData),
      );
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
  onError: (error) => ({
    error: t("pricing.routes.marketplace.accountDeskRepricing.actionFailed"),
    details: pricingValidationMessages(error),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountDeskRepricing.policy.meta.title"),
    description: t("pricing.routes.marketplace.accountDeskRepricing.meta.description"),
  });

export default function MarketplaceSellerDeskRepricingPolicyRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; details?: readonly string[] } | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const submit = useSubmit();
  const [editorOpen, setEditorOpen] = useState(false);
  const [openedAtKey, setOpenedAtKey] = useState(location.key);
  useEffect(() => {
    if (!actionData?.error) setEditorOpen(false);
  }, [location.key]);
  const [, setSearchParams] = useSearchParams();
  useRepricingDeskCatchUp(data.recovery === "catching-up");
  if (data.recovery === "catching-up") {
    return <PricingRepricingPolicyCatchingUpPage refreshHref={`${location.pathname}${location.search}`} />;
  }
  const policyId = data.policy.policyId ?? "";
  const submitIntent = (intent: string) => submit({ intent, policyId }, { method: "post" });
  const navigating = navigation.state === "loading" && !navigation.formData;

  return (
    <>
      <PricingRepricingPolicyDetailPage
        editAction={
          data.policy.status !== "deleted" ? (
            <Button
              onClick={() => {
                setOpenedAtKey(location.key);
                setEditorOpen(true);
              }}
            >
              {t("pricing.features.repricingPolicies.ui.editor.revise")}
            </Button>
          ) : null
        }
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
      {editorOpen && data.policy.scope && data.policy.maxChangesPerDay !== null ? (
        <PolicyEditorDrawer
          policyId={policyId}
          initialBody={{
            name: data.policy.name ?? "",
            scope: data.policy.scope,
            rules: data.policy.rules,
            excludedListingIds: data.policy.excludedListingIds,
            maxChangesPerDay: data.policy.maxChangesPerDay,
          }}
          onClose={() => setEditorOpen(false)}
          saving={navigation.state === "submitting"}
          saveErrors={
            location.key === openedAtKey
              ? []
              : actionData?.details?.length
                ? actionData.details
                : actionData?.error
                  ? [actionData.error]
                  : []
          }
          onSave={({ body }) =>
            submit({ intent: "revise-policy", policyId, body: JSON.stringify(body) }, { method: "post" })
          }
        />
      ) : null}
    </>
  );
}
