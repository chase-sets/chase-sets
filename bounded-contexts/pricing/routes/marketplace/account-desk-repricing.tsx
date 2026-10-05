import { t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import { Button } from "@chase-sets/design-system";
import { PolicyEditorDrawer } from "../../features/repricing-policies/ui/policy-editor-drawer";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useNavigation, useSubmit } from "react-router";
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
  type RepricingDryRun,
  type RepricingPolicyListItem,
} from "../../support/request-support/api-client";
import { pricingApiErrorAdapter } from "../../support/request-support/route-api-error";
import { useRepricingDeskCatchUp } from "../../support/route-support/repricing-desk-catch-up";
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

// Halt and dry-run reads never carry the policy receipt; an outage in either
// keeps the page's error state.
async function loadRepricingDeskAncillaries(request: Request) {
  const api = createPricingRequestApiClient(repricingDeskRequestWithoutFreshWrite(request));
  const [halt, dryRuns] = await Promise.all([
    loadOrUnavailable(() => api.getRepricingHalt()),
    loadOrUnavailable(() => api.listRepricingDryRuns()),
  ]);
  return { halt: halt ?? releasedHalt, dryRuns: dryRuns ?? [], haltFailed: halt === null };
}

type RepricingDeskLoaderData = Readonly<{
  policies: readonly RepricingPolicyListItem[];
  halt: RepricingHaltState;
  dryRuns: readonly RepricingDryRun[];
  catchingUp: boolean;
  loadFailed: boolean;
}>;

export const loader = defineResourceRoute<readonly RepricingPolicyListItem[], RepricingDeskLoaderData>({
  manifest: contextManifest,
  routeId: "account-desk-repricing",
  prepare: async (args) => ({ ...args, request: await resolveRepricingDeskPostWriteRequest(args.request) }),
  authorization: { permission: "pricing.view" },
  errorAdapter: pricingApiErrorAdapter,
  load: ({ request }) => createPricingRequestApiClient(request).listRepricingPolicies(),
  map: async (policies, { request }) => {
    const { halt, dryRuns, haltFailed } = await loadRepricingDeskAncillaries(request);
    return { policies, halt, dryRuns, catchingUp: false, loadFailed: haltFailed };
  },
  telemetry: REPRICING_DESK_POST_WRITE_TELEMETRY,
  onPending: async (_result, { request }) => {
    const { halt, dryRuns, haltFailed } = await loadRepricingDeskAncillaries(request);
    return { policies: [], halt, dryRuns, catchingUp: true, loadFailed: haltFailed };
  },
  // Outages keep the page's error state; authorization and validation errors
  // are never reported as projection lag.
  onPermanentFailure: async (result, { request }) => {
    const error = "error" in result ? result.error : null;
    if (!(error instanceof PricingApiError && error.status >= 500)) throw error;
    const { halt, dryRuns } = await loadRepricingDeskAncillaries(request);
    return { policies: [], halt, dryRuns, catchingUp: false, loadFailed: true };
  },
});

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
    "create-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).createRepricingPolicy({
        dryRunId: String(formData.get("dryRunId") ?? ""),
        name: String(formData.get("name") ?? ""),
      });
      return redirect(await navigateAfterWriteToRepricingDesk(result));
    },
    "pause-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).pauseRepricingPolicy(repricingPolicyIdFrom(formData));
      return redirect(await navigateAfterWriteToRepricingDesk(result));
    },
    "resume-policy": async ({ request, formData }) => {
      const result = await createPricingRequestApiClient(request).resumeRepricingPolicy(
        repricingPolicyIdFrom(formData),
      );
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
  onError: (error) => ({
    error: t("pricing.routes.marketplace.accountDeskRepricing.actionFailed"),
    details: pricingValidationMessages(error),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountDeskRepricing.meta.title"),
    description: t("pricing.routes.marketplace.accountDeskRepricing.meta.description"),
  });

export default function MarketplaceSellerDeskRepricingRoute() {
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
  useRepricingDeskCatchUp(data.catchingUp);
  const pendingPolicyId = navigation.formData ? repricingPolicyIdFrom(navigation.formData) : "";
  const submitIntent = (intent: string, policyId?: string) =>
    submit(policyId ? { intent, policyId } : { intent }, { method: "post" });

  return (
    <>
      <PricingRepricingPolicyListPage
        createAction={
          <Button
            onClick={() => {
              setOpenedAtKey(location.key);
              setEditorOpen(true);
            }}
          >
            {t("pricing.features.repricingPolicies.ui.editor.create")}
          </Button>
        }
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
      {editorOpen ? (
        <PolicyEditorDrawer
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
          onSave={({ body, dryRunId }) =>
            submit({ intent: "create-policy", name: body.name, dryRunId: dryRunId ?? "" }, { method: "post" })
          }
        />
      ) : null}
    </>
  );
}
