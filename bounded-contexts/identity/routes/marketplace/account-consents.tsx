import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, defineResourceRoute } from "@chase-sets/platform-runtime/http";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import {
  accountMutationResponse,
  requireInterruptionSafeClient,
} from "../../features/account-management/api/marketplace-action";
import type { MutationResult } from "../../features/account-management/api/runtime";
import { AccountMutationBoundary } from "../../features/account-management/ui/controller";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { Consent } from "../../support/request-support/api-client";
import { ConsentHistoryPage } from "../../features/consents/ui/consent-history-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import { identityApiErrorAdapter } from "../../support/request-support/route-api-error";
import contextManifest from "../../context.json";

type ActionData = Readonly<{ error?: string }>;

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-consents",
  authorization: ({ request }) => requireActorFromIdentityApi({ request }),
  errorAdapter: identityApiErrorAdapter,
  load: ({ request, actor }) =>
    createIdentityRequestApiClient(request).listConsents<ListResponse<Consent>>(
      `limit=50&offset=0&userId=${encodeURIComponent(actor!.userId)}&accountId=${encodeURIComponent(actor!.accountId)}`,
    ),
  map: (response, { actor }) => ({
    consents: response.items,
    loadError: null,
    mutationActor: { tenantId: actor!.tenantId, userId: actor!.userId, accountId: actor!.accountId },
  }),
  onPending: (_result, { actor }) => ({
    mutationActor: { tenantId: actor!.tenantId, userId: actor!.userId, accountId: actor!.accountId },
    consents: [] as readonly Consent[],
    loadError: t("identity.routes.marketplace.accountConsents.consents.updating"),
  }),
  messages: { notFound: t("identity.routes.marketplace.accountConsents.consents.unavailable") },
});

export const action = requireInterruptionSafeClient(
  defineFormAction({
    authorization: ({ request }) => requireActorFromIdentityApi({ request }),
    intents: {
      withdraw: async ({ request, formData }) => {
        const consentId = String(formData.get("consentId") ?? "").trim();
        if (!consentId) {
          return { error: t("identity.routes.marketplace.accountConsents.consent.required") } satisfies ActionData;
        }

        const result = await createIdentityRequestApiClient(request).withdrawConsent<MutationResult>(consentId);
        return accountMutationResponse(result, "/account/consents", navigateAfterWrite(result, "/account/consents"));
      },
    },
    onUnknownIntent: () => ({ error: t("identity.routes.marketplace.accountConsents.unknown.action") }),
    onError: (error) => ({
      error: error instanceof Error ? error.message : t("identity.routes.marketplace.accountConsents.request.failed"),
    }),
  }),
);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountConsents.consents.marketplace") });

export default function MarketplaceAccountConsentsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  return (
    <AccountMutationBoundary
      key={`${data.mutationActor.tenantId}:${data.mutationActor.userId}:${data.mutationActor.accountId}`}
      actor={data.mutationActor}
    >
      <ConsentHistoryPage consents={data.consents} errorMessage={actionData?.error ?? data.loadError ?? null} />
    </AccountMutationBoundary>
  );
}
