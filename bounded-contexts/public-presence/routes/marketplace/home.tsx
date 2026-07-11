import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  PublicPresenceApiError,
  createPublicPresenceRequestApiClient,
  type SubmitWaitlistSignupRequest,
} from "../../support/request-support/api-client";
import { PublicPresenceHomePage } from "../../features/waitlist/ui/public-pages";
import heroImageUrl from "../../features/waitlist/ui/assets/chase-sets-prelaunch-hero.webp?url";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

const fallbackPublicOrigin = "https://chasesets.com";
const faqStructuredDataEntries = [
  ["publicPresence.faq.launch.question", "publicPresence.faq.launch.answer"],
  ["publicPresence.faq.fees.question", "publicPresence.faq.fees.answer"],
  ["publicPresence.faq.shipping.question", "publicPresence.faq.shipping.answer"],
  ["publicPresence.faq.safety.question", "publicPresence.faq.safety.answer"],
] as const;

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
  const publicOrigin = process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || url.origin;
  const discordInviteUrl = process.env.CHASE_SETS_DISCORD_INVITE_URL?.trim() || null;
  if (!discordInviteUrl && process.env.NODE_ENV !== "production") {
    // The Discord CTA now renders unconditionally wherever this env var is
    // set; an unset var here is a startup-config gap, not an intended
    // silent feature drop, so it must be loud in non-prod logs instead of
    // quietly vanishing from the page.
    console.warn(
      "[public-presence] CHASE_SETS_DISCORD_INVITE_URL is not set. The Discord CTA will not render until it is configured.",
    );
  }
  return {
    discordInviteUrl,
    publicOrigin,
    source: {
      pagePath: `${url.pathname}${url.search}`,
      referrer: request.headers.get("referer"),
      utmSource: url.searchParams.get("utm_source"),
      utmMedium: url.searchParams.get("utm_medium"),
      utmCampaign: url.searchParams.get("utm_campaign"),
      utmContent: url.searchParams.get("utm_content"),
      utmTerm: url.searchParams.get("utm_term"),
      // Raw referral code from an inbound `?ref=` link; the domain command
      // is the sole validator (shape check, self-referral guard), so the
      // route stays composition-only and just forwards what it received.
      referredBySignupId: url.searchParams.get("ref"),
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createPublicPresenceRequestApiClient(request);
  const marketingConsent = formData.get("marketingConsent");

  try {
    const result = await api.submitWaitlistSignup({
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? "both") as SubmitWaitlistSignupRequest["role"],
      interests: formData.getAll("interests").map(String) as SubmitWaitlistSignupRequest["interests"],
      marketingConsent: marketingConsent === "yes" || marketingConsent === "on",
      referredBySignupId: optional(formData.get("referredBySignupId")),
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
    // Land signers-up on a dedicated success page (with their referral link
    // and "move up the list" progress) instead of an inline banner. The
    // commit receipt travels in the redirect query string; the welcome page
    // needs no projection read to render its primary confirmation.
    const welcomeUrl = new URL("/welcome", request.url);
    welcomeUrl.searchParams.set("signup", result.id);
    welcomeUrl.searchParams.set("fresh", "1");
    if (optional(formData.get("referredBySignupId"))) {
      // Coarse hint only (never the code itself) so the success page fires
      // waitlist_signup_attributed once; a malformed/self-referral code that
      // the domain drops server-side still sets this hint, which is an
      // accepted directional-analytics approximation, not durable truth.
      welcomeUrl.searchParams.set("attributed", "1");
    }
    return redirect(`${welcomeUrl.pathname}${welcomeUrl.search}`);
  } catch (error) {
    return { status: "error" as const, message: actionErrorMessage(error) };
  }
}

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

function publicUrl(origin: string, path: string) {
  return new URL(path, `${normalizeOrigin(origin)}/`).toString();
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const publicOrigin = normalizeOrigin(data?.publicOrigin ?? fallbackPublicOrigin);
  const homeUrl = publicUrl(publicOrigin, "/");
  const imageUrl = publicUrl(publicOrigin, heroImageUrl);

  return [
    { title: t("publicPresence.routes.home.meta.title") },
    { name: "description", content: t("publicPresence.routes.home.meta.description") },
    { property: "og:site_name", content: t("publicPresence.brand") },
    { property: "og:title", content: t("publicPresence.routes.home.meta.title") },
    { property: "og:description", content: t("publicPresence.routes.home.meta.description") },
    { property: "og:type", content: "website" },
    { property: "og:url", content: homeUrl },
    { property: "og:image", content: imageUrl },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: t("publicPresence.routes.home.meta.title") },
    { name: "twitter:description", content: t("publicPresence.routes.home.meta.description") },
    { name: "twitter:image", content: imageUrl },
  ];
};

export function buildHomeStructuredData(publicOrigin = fallbackPublicOrigin) {
  const normalizedOrigin = normalizeOrigin(publicOrigin);
  const homeUrl = publicUrl(normalizedOrigin, "/");

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${homeUrl}#organization`,
        name: t("publicPresence.brand"),
        url: homeUrl,
        contactPoint: {
          "@type": "ContactPoint",
          email: "support@chasesets.com",
          contactType: "customer support",
        },
      },
      {
        "@type": "WebSite",
        "@id": `${homeUrl}#website`,
        name: t("publicPresence.brand"),
        url: homeUrl,
        publisher: {
          "@id": `${homeUrl}#organization`,
        },
        potentialAction: {
          "@type": "RegisterAction",
          name: t("publicPresence.waitlist.submit"),
          target: `${homeUrl}#waitlist-form`,
        },
      },
      {
        "@type": "FAQPage",
        "@id": `${homeUrl}#landing-faq`,
        mainEntity: faqStructuredDataEntries.map(([question, answer]) => ({
          "@type": "Question",
          name: t(question),
          acceptedAnswer: {
            "@type": "Answer",
            text: t(answer),
          },
        })),
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
          __html: JSON.stringify(buildHomeStructuredData(data.publicOrigin)).replace(/</g, "\\u003c"),
        }}
      />
      <PublicPresenceHomePage actionData={actionData} discordInviteUrl={data.discordInviteUrl} source={data.source} />
    </>
  );
}
