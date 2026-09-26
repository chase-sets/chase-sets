import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useNavigation, useSubmit } from "react-router";
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
import {
  repricingDeskRequestWithoutFreshWrite,
  resolveRepricingDeskPostWriteRequest,
} from "../../support/route-support/repricing-desk-post-write";
import {
  PricingRepricingPolicyListPage,
  type RepricingHaltState,
} from "../../features/repricing-policies/ui/policy-list-page";

export const REPRICING_DESK_HREF = "/account/desk/repricing";

const releasedHalt: RepricingHaltState = { engaged: false, engagedAt: null, releasedAt: null };

// A pricing API outage renders the page's error state; authorization and
// validation failures still propagate to the route error boundary.
export async function loadOrUnavailable<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof PricingApiError && error.status >= 500) return null;
    throw error;
  }
}

const REPRICING_DESK_POST_WRITE_TELEMETRY = {
  boundedContextName: "pricing",
  surface: "account-desk-repricing",
  routeId: "account-desk-repricing",
  routeTemplate: REPRICING_DESK_HREF,
} as const satisfies PlatformPostWriteTelemetry;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  const resolvedRequest = await resolveRepricingDeskPostWriteRequest(request);
  const api = createPricingRequestApiClient(resolvedRequest);
  const ancillaryApi = createPricingRequestApiClient(repricingDeskRequestWithoutFreshWrite(resolvedRequest));
  const [policiesRead, halt, dryRuns] = await Promise.all([
    loadAfterWrite({
      request: resolvedRequest,
      isNotFound: (error) => error instanceof PricingApiError && error.status === 404,
      load: () => api.listRepricingPolicies(),
      telemetry: REPRICING_DESK_POST_WRITE_TELEMETRY,
    }),
    loadOrUnavailable(() => ancillaryApi.getRepricingHalt()),
    loadOrUnavailable(() => ancillaryApi.listRepricingDryRuns()),
  ]);

  // Outages keep the page's error state; authorization and validation errors
  // are never reported as projection lag.
  if (policiesRead.kind === "permanent-failure") {
    const error = "error" in policiesRead ? policiesRead.error : null;
    if (!(error instanceof PricingApiError && error.status >= 500)) throw error;
  }

  return {
    policies: policiesRead.kind === "data" ? policiesRead.data : [],
    halt: halt ?? releasedHalt,
    dryRuns: dryRuns ?? [],
    catchingUp: policiesRead.kind === "pending",
    loadFailed: policiesRead.kind === "permanent-failure" || halt === null,
  };
}

export function repricingPolicyIdFrom(formData: FormData): string {
  return String(formData.get("policyId") ?? "").trim();
}

// Policy commands carry their commit receipt into the list's fresh read. Halt
// changes stay plain redirects: the halt is read from its own aggregate.
export function navigateAfterWriteToRepricingDesk(commandResult: unknown) {
  return navigateAfterWriteWithPlatformPostWriteToken(commandResult, REPRICING_DESK_HREF, {
    telemetry: REPRICING_DESK_POST_WRITE_TELEMETRY,
  });
}

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    "pause-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).pauseRepricingPolicy(repricingPolicyIdFrom(formData));
      return redirect(await navigateAfterWriteToRepricingDesk(result));
    },
    "resume-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).resumeRepricingPolicy(repricingPolicyIdFrom(formData));
      return redirect(await navigateAfterWriteToRepricingDesk(result));
    },
    "engage-halt": async ({ request }) => {
      await createPricingRequestApiClient(request).setRepricingHalt(true);
      return formActionRedirect(null, REPRICING_DESK_HREF);
    },
    "release-halt": async ({ request }) => {
      await createPricingRequestApiClient(request).setRepricingHalt(false);
      return formActionRedirect(null, REPRICING_DESK_HREF);
    },
  },
  onUnknownIntent: () => ({ error: t("pricing.routes.marketplace.accountDeskRepricing.unknownAction") }),
  onError: () => ({ error: t("pricing.routes.marketplace.accountDeskRepricing.actionFailed") }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountDeskRepricing.meta.title"),
    description: t("pricing.routes.marketplace.accountDeskRepricing.meta.description"),
  });

export default function MarketplaceSellerDeskRepricingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const submit = useSubmit();
  const pendingPolicyId = navigation.formData ? repricingPolicyIdFrom(navigation.formData) : "";
  const submitIntent = (intent: string, policyId?: string) =>
    submit(policyId ? { intent, policyId } : { intent }, { method: "post" });

  return (
    <PricingRepricingPolicyListPage
      policies={data.policies}
      halt={data.halt}
      dryRuns={data.dryRuns}
      loading={navigation.state === "loading" && !navigation.formData}
      loadFailed={data.loadFailed}
      catchingUpHref={data.catchingUp ? `${location.pathname}${location.search}` : null}
      errorMessage={actionData && "error" in actionData ? String(actionData.error ?? "") : null}
      busyPolicyId={pendingPolicyId || null}
      onHaltChange={(engaged) => submitIntent(engaged ? "engage-halt" : "release-halt")}
      onPause={(policyId) => submitIntent("pause-policy", policyId)}
      onResume={(policyId) => submitIntent("resume-policy", policyId)}
    />
  );
}
