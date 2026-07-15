import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
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
  map: (response) => ({ consents: response.items, loadError: null }),
  onPending: () => ({
    consents: [] as readonly Consent[],
    loadError: t("identity.routes.marketplace.accountConsents.consents.updating"),
  }),
  messages: { notFound: t("identity.routes.marketplace.accountConsents.consents.unavailable") },
});

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromIdentityApi({ request }),
  intents: {
    withdraw: async ({ request, formData }) => {
      const consentId = String(formData.get("consentId") ?? "").trim();
      if (!consentId) {
        return { error: t("identity.routes.marketplace.accountConsents.consent.required") } satisfies ActionData;
      }

      return formActionRedirect(
        await createIdentityRequestApiClient(request).withdrawConsent(consentId),
        "/account/consents",
      );
    },
  },
  onUnknownIntent: () => ({ error: t("identity.routes.marketplace.accountConsents.unknown.action") }),
  onError: (error) => ({
    error: error instanceof Error ? error.message : t("identity.routes.marketplace.accountConsents.request.failed"),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountConsents.consents.marketplace") });

export default function MarketplaceAccountConsentsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  return <ConsentHistoryPage consents={data.consents} errorMessage={actionData?.error ?? data.loadError ?? null} />;
}
