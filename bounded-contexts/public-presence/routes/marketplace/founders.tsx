import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  buildFoundersOfferTermsMeta,
  FoundersOfferTermsRouteAdapter,
} from "../../features/policies/ui/policy-artifact-route-adapter";
import { buildPublicSocialMeta, publicOpenGraphImages } from "../../features/waitlist/ui/social-meta";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ request }: LoaderFunctionArgs) {
  // Social meta needs absolute URLs; mirror the home route's origin
  // resolution so shared /founders links carry the founders OG card.
  return { publicOrigin: process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildFoundersOfferTermsMeta(),
  ...buildPublicSocialMeta({
    publicOrigin: data?.publicOrigin ?? "https://chasesets.com",
    path: "/founders",
    title: t("publicPresence.routes.founders.meta.title"),
    description: t("publicPresence.routes.founders.meta.description"),
    imagePath: publicOpenGraphImages.founders,
  }),
];

export default function FoundersRoute() {
  return <FoundersOfferTermsRouteAdapter />;
}
