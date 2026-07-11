import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { PromoBarAdminPage } from "../../features/promo-bar/ui/admin-pages";
import type { PromoBarMessage, PromoBarMessageTone } from "../../features/promo-bar/api/contracts";
import { PublicPresenceApiError, createPublicPresenceRequestApiClient } from "../../support/request-support/api-client";

function optional(formData: FormData, key: string) {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
}

function messageBody(formData: FormData) {
  return {
    title: String(formData.get("title") ?? ""),
    description: optional(formData, "description"),
    href: optional(formData, "href"),
    linkLabel: optional(formData, "linkLabel"),
    tone: String(formData.get("tone") ?? "info") as PromoBarMessageTone,
    isActive: formData.get("isActive") === "true",
    displayOrder: Number(formData.get("displayOrder") ?? 100),
    startsAt: optional(formData, "startsAt"),
    endsAt: optional(formData, "endsAt"),
  };
}

function resolveMarketplaceOrigin(request: Request) {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  if (configured) {
    return configured;
  }

  return new URL(request.url).origin;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  const messages = await api.listPromoBarMessages();
  return { ...messages, currentTime: new Date().toISOString(), marketplaceOrigin: resolveMarketplaceOrigin(request) };
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");

  try {
    let message = t("publicPresence.promoBar.action.noop");

    if (intent === "create") {
      await api.createPromoBarMessage(messageBody(formData));
      message = t("publicPresence.promoBar.action.created");
    } else if (intent === "update" && id) {
      await api.updatePromoBarMessage(id, messageBody(formData));
      message = t("publicPresence.promoBar.action.updated");
    } else if (intent === "activate" && id) {
      await api.activatePromoBarMessage(id);
      message = t("publicPresence.promoBar.action.activated");
    } else if (intent === "deactivate" && id) {
      await api.deactivatePromoBarMessage(id);
      message = t("publicPresence.promoBar.action.deactivated");
    } else if (intent === "delete" && id) {
      await api.deletePromoBarMessage(id);
      message = t("publicPresence.promoBar.action.deleted");
    }

    const refreshed = await api.listPromoBarMessages();
    return { message, error: null, currentTime: new Date().toISOString(), items: refreshed.items };
  } catch (error) {
    if (error instanceof PublicPresenceApiError || error instanceof Error) {
      return { message: null, error: error.message, currentTime: new Date().toISOString(), items: null };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [{ title: t("publicPresence.routes.admin.promoBar.meta.title") }];

export default function PromoBarAdminRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const messages = (actionData?.items as PromoBarMessage[] | null | undefined) ?? data.items;

  return (
    <PromoBarAdminPage
      messages={messages}
      actionMessage={actionData?.message ?? null}
      errorMessage={actionData?.error ?? null}
      currentTime={actionData?.currentTime ?? data.currentTime}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
