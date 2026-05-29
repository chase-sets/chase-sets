import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { PromoBarAdminPage } from "../../features/promo-bar/ui/admin-pages";
import { createPublicPresenceRequestApiClient } from "../../support/request-support/api-client";

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
    tone: String(formData.get("tone") ?? "info") as never,
    isActive: formData.get("isActive") === "true",
    displayOrder: Number(formData.get("displayOrder") ?? 100),
    startsAt: optional(formData, "startsAt"),
    endsAt: optional(formData, "endsAt"),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  return api.listPromoBarMessages();
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");

  if (intent === "create") {
    await api.createPromoBarMessage(messageBody(formData));
    return { message: t("publicPresence.promoBar.action.created") };
  }

  if (intent === "update" && id) {
    await api.updatePromoBarMessage(id, messageBody(formData));
    return { message: t("publicPresence.promoBar.action.updated") };
  }

  if (intent === "activate" && id) {
    await api.activatePromoBarMessage(id);
    return { message: t("publicPresence.promoBar.action.activated") };
  }

  if (intent === "deactivate" && id) {
    await api.deactivatePromoBarMessage(id);
    return { message: t("publicPresence.promoBar.action.deactivated") };
  }

  if (intent === "delete" && id) {
    await api.deletePromoBarMessage(id);
    return { message: t("publicPresence.promoBar.action.deleted") };
  }

  return { message: t("publicPresence.promoBar.action.noop") };
}

export const meta: MetaFunction = () => [{ title: t("publicPresence.routes.admin.promoBar.meta.title") }];

export default function PromoBarAdminRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return <PromoBarAdminPage messages={data.items} actionMessage={actionData?.message ?? null} />;
}
