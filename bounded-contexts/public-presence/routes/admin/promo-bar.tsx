import { t } from "@chase-sets/localization";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { PromoBarAdminPage } from "../../features/promo-bar/ui/admin-pages";
import type { PromoBarMessage, PromoBarMessageTone } from "../../features/promo-bar/api/contracts";
import { PublicPresenceApiError, createPublicPresenceRequestApiClient } from "../../support/request-support/api-client";

function optional(formData: FormData, key: string) {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
}

// The form sends each time as the instant the browser read in the operator's
// zone (`LocalDateTimeInput`), with the typed text in `<name>Local`. A blank
// field is `null`; a time that is not an instant is refused rather than sent
// for the API to read in its zone.
function scheduledTime(formData: FormData, name: string): string | null {
  const instant = String(formData.get(name) ?? "").trim();
  const typed = String(formData.get(`${name}Local`) ?? "").trim();
  if (!instant && !typed) {
    return null;
  }
  try {
    return parseIsoUtcTimestamp(instant);
  } catch {
    throw new PromoBarScheduleError(t("publicPresence.promoBar.action.invalidTime"));
  }
}

class PromoBarScheduleError extends Error {}

function messageBody(formData: FormData) {
  return {
    title: String(formData.get("title") ?? ""),
    description: optional(formData, "description"),
    href: optional(formData, "href"),
    linkLabel: optional(formData, "linkLabel"),
    tone: String(formData.get("tone") ?? "info") as PromoBarMessageTone,
    isActive: formData.get("isActive") === "true",
    displayOrder: Number(formData.get("displayOrder") ?? 100),
    startsAt: scheduledTime(formData, "startsAt"),
    endsAt: scheduledTime(formData, "endsAt"),
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

async function promoActionResult(request: Request, message: string) {
  const api = createPublicPresenceRequestApiClient(request);
  const refreshed = await api.listPromoBarMessages();
  return { message, error: null, currentTime: new Date().toISOString(), items: refreshed.items };
}

export const action = defineFormAction({
  intents: {
    create: async ({ request, formData }) => {
      await createPublicPresenceRequestApiClient(request).createPromoBarMessage(messageBody(formData));
      return promoActionResult(request, t("publicPresence.promoBar.action.created"));
    },
    update: async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      if (id) await createPublicPresenceRequestApiClient(request).updatePromoBarMessage(id, messageBody(formData));
      return promoActionResult(
        request,
        t(id ? "publicPresence.promoBar.action.updated" : "publicPresence.promoBar.action.noop"),
      );
    },
    activate: async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      if (id) await createPublicPresenceRequestApiClient(request).activatePromoBarMessage(id);
      return promoActionResult(
        request,
        t(id ? "publicPresence.promoBar.action.activated" : "publicPresence.promoBar.action.noop"),
      );
    },
    deactivate: async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      if (id) await createPublicPresenceRequestApiClient(request).deactivatePromoBarMessage(id);
      return promoActionResult(
        request,
        t(id ? "publicPresence.promoBar.action.deactivated" : "publicPresence.promoBar.action.noop"),
      );
    },
    delete: async ({ request, formData }) => {
      const id = String(formData.get("id") ?? "");
      if (id) await createPublicPresenceRequestApiClient(request).deletePromoBarMessage(id);
      return promoActionResult(
        request,
        t(id ? "publicPresence.promoBar.action.deleted" : "publicPresence.promoBar.action.noop"),
      );
    },
  },
  onUnknownIntent: ({ request }) => promoActionResult(request, t("publicPresence.promoBar.action.noop")),
  onError: (error) => {
    if (error instanceof PublicPresenceApiError || error instanceof Error) {
      return { message: null, error: error.message, currentTime: new Date().toISOString(), items: null };
    }
    throw error;
  },
});

export const meta: MetaFunction = () => [{ title: t("publicPresence.routes.admin.promoBar.meta.title") }];

export default function PromoBarAdminRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | {
        message: string | null;
        error: string | null;
        currentTime: string;
        items: PromoBarMessage[] | null;
      }
    | undefined;
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
