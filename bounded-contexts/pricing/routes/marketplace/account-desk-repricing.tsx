import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../support/request-support/api-client";
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

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  const api = createPricingRequestApiClient(request);
  const [policies, halt, dryRuns] = await Promise.all([
    loadOrUnavailable(() => api.listRepricingPolicies()),
    loadOrUnavailable(() => api.getRepricingHalt()),
    loadOrUnavailable(() => api.listRepricingDryRuns()),
  ]);

  return {
    policies: policies ?? [],
    halt: halt ?? releasedHalt,
    dryRuns: dryRuns ?? [],
    loadFailed: policies === null || halt === null,
  };
}

export function repricingPolicyIdFrom(formData: FormData): string {
  return String(formData.get("policyId") ?? "").trim();
}

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    "pause-policy": async ({ request, formData }) => {
      await createPricingRequestApiClient(request).pauseRepricingPolicy(repricingPolicyIdFrom(formData));
      return formActionRedirect(null, REPRICING_DESK_HREF);
    },
    "resume-policy": async ({ request, formData }) => {
      await createPricingRequestApiClient(request).resumeRepricingPolicy(repricingPolicyIdFrom(formData));
      return formActionRedirect(null, REPRICING_DESK_HREF);
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
      errorMessage={actionData && "error" in actionData ? String(actionData.error ?? "") : null}
      busyPolicyId={pendingPolicyId || null}
      onHaltChange={(engaged) => submitIntent(engaged ? "engage-halt" : "release-halt")}
      onPause={(policyId) => submitIntent("pause-policy", policyId)}
      onResume={(policyId) => submitIntent("resume-policy", policyId)}
    />
  );
}
