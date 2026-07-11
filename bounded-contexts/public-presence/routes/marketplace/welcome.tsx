import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { WaitlistSuccessPage } from "../../features/waitlist/ui/success-page";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

const fallbackPublicOrigin = "https://chasesets.com";
const waitlistSignupIdPattern = /^wls_[0-9a-z]+$/;

function normalizeSignupId(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return waitlistSignupIdPattern.test(trimmed) ? trimmed : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const signupId = normalizeSignupId(url.searchParams.get("signup"));

  if (!signupId) {
    throw new Response("Not Found", { status: 404 });
  }

  const discordInviteUrl = process.env.CHASE_SETS_DISCORD_INVITE_URL?.trim() || null;
  if (!discordInviteUrl && process.env.NODE_ENV !== "production") {
    // See routes/marketplace/home.tsx: an unset invite URL is a
    // startup-config gap to fix, not a silent feature drop to tolerate.
    console.warn(
      "[public-presence] CHASE_SETS_DISCORD_INVITE_URL is not set. The Discord CTA will not render until it is configured.",
    );
  }

  return {
    signupId,
    attributed: url.searchParams.get("attributed") === "1",
    publicOrigin: process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || url.origin,
    discordInviteUrl,
  };
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: t("publicPresence.routes.welcome.meta.title") },
  // The referral code embedded in this page's own share link is meant to be
  // shared deliberately, not indexed; keep this URL out of search results.
  { name: "robots", content: "noindex, nofollow" },
];

export default function PublicPresenceWelcomeRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <WaitlistSuccessPage
      signupId={data.signupId}
      publicOrigin={data.publicOrigin || fallbackPublicOrigin}
      discordInviteUrl={data.discordInviteUrl}
      attributed={data.attributed}
    />
  );
}
