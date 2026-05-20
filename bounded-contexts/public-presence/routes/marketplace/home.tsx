import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  PublicPresenceApiError,
  createPublicPresenceRequestApiClient,
} from "../../support/request-support/api-client";
import { PublicPresenceHomePage } from "../../features/waitlist/ui/public-pages";
import heroImageUrl from "../../features/waitlist/ui/assets/chase-sets-prelaunch-hero.webp?url";

const publicSiteUrl = "https://chasesets.com";

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
  { tagName: "link", rel: "canonical", href: `${publicSiteUrl}/` },
  { property: "og:site_name", content: t("publicPresence.brand") },
  { property: "og:title", content: t("publicPresence.routes.home.meta.title") },
  { property: "og:description", content: t("publicPresence.routes.home.meta.description") },
  { property: "og:type", content: "website" },
  { property: "og:url", content: `${publicSiteUrl}/` },
  { property: "og:image", content: `${publicSiteUrl}${heroImageUrl}` },
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:title", content: t("publicPresence.routes.home.meta.title") },
  { name: "twitter:description", content: t("publicPresence.routes.home.meta.description") },
  { name: "twitter:image", content: `${publicSiteUrl}${heroImageUrl}` },
];

export function buildHomeStructuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${publicSiteUrl}/#organization`,
        name: t("publicPresence.brand"),
        url: `${publicSiteUrl}/`,
        contactPoint: {
          "@type": "ContactPoint",
          email: "support@chasesets.com",
          contactType: "customer support",
        },
      },
      {
        "@type": "WebSite",
        "@id": `${publicSiteUrl}/#website`,
        name: t("publicPresence.brand"),
        url: `${publicSiteUrl}/`,
        publisher: {
          "@id": `${publicSiteUrl}/#organization`,
        },
        potentialAction: {
          "@type": "RegisterAction",
          name: t("publicPresence.waitlist.submit"),
          target: `${publicSiteUrl}/#waitlist-form`,
        },
      },
    ],
  } as const;
}

export const publicPresenceHomeJsonLd = buildHomeStructuredData;

export default function PublicPresenceHomeRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() ?? null;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildHomeStructuredData()).replace(/</g, "\\u003c"),
        }}
      />
      <PublicPresenceHomePage
        actionData={actionData}
        discordInviteUrl={data.discordInviteUrl}
        source={data.source}
      />
    </>
  );
}
