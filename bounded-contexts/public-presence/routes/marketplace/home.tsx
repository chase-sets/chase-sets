import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  PublicPresenceApiError,
  createPublicPresenceRequestApiClient,
} from "../../support/request-support/api-client";
import { PublicPresenceHomePage } from "../../features/waitlist/ui/public-pages";
import heroImageUrl from "../../support/shell-support/assets/chase-sets-prelaunch-hero.webp?url";

function optional(value: FormDataEntryValue | null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function actionErrorMessage(error: unknown) {
  if (error instanceof PublicPresenceApiError) {
    const body = error.body as { error?: { message?: string } } | null;
    return body?.error?.message ?? t("publicPresence.routes.home.waitlist.failed");
  }

  return t("publicPresence.routes.home.waitlist.failed");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    discordInviteUrl: process.env.CHASE_SETS_DISCORD_INVITE_URL?.trim() || null,
    source: {
      pagePath: `${url.pathname}${url.search}`,
      referrer: request.headers.get("referer"),
      utmSource: url.searchParams.get("utm_source"),
      utmMedium: url.searchParams.get("utm_medium"),
      utmCampaign: url.searchParams.get("utm_campaign"),
      utmContent: url.searchParams.get("utm_content"),
      utmTerm: url.searchParams.get("utm_term"),
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createPublicPresenceRequestApiClient(request);

  try {
    await api.submitWaitlistSignup({
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? "both") as never,
      interests: formData.getAll("interests").map(String) as never,
      emailConsent: formData.get("emailConsent") === "yes",
      website: optional(formData.get("website")),
      source: {
        pagePath: String(formData.get("pagePath") ?? "/"),
        referrer: optional(formData.get("referrer")),
        utmSource: optional(formData.get("utmSource")),
        utmMedium: optional(formData.get("utmMedium")),
        utmCampaign: optional(formData.get("utmCampaign")),
        utmContent: optional(formData.get("utmContent")),
        utmTerm: optional(formData.get("utmTerm")),
      },
    });
    return { status: "joined" as const };
  } catch (error) {
    return { status: "error" as const, message: actionErrorMessage(error) };
  }
}

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.home.meta.title") },
  { name: "description", content: t("publicPresence.routes.home.meta.description") },
  { property: "og:site_name", content: t("publicPresence.brand") },
  { property: "og:title", content: t("publicPresence.routes.home.meta.title") },
  { property: "og:description", content: t("publicPresence.routes.home.meta.description") },
  { property: "og:type", content: "website" },
  { property: "og:image", content: `https://chasesets.com${heroImageUrl}` },
  { name: "twitter:card", content: "summary_large_image" },
];

export default function PublicPresenceHomeRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() ?? null;
  return (
    <PublicPresenceHomePage
      actionData={actionData}
      discordInviteUrl={data.discordInviteUrl}
      source={data.source}
    />
  );
}
