import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";
import { buildPublicSocialMeta, publicOpenGraphImages } from "../../features/waitlist/ui/social-meta";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export function loader({ request }: LoaderFunctionArgs) {
  // Social meta needs absolute URLs; mirror the home route's origin
  // resolution so shared /founders links carry the founders OG card.
  return { publicOrigin: process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: t("publicPresence.routes.founders.meta.title") },
  { name: "description", content: t("publicPresence.routes.founders.meta.description") },
  ...buildPublicSocialMeta({
    publicOrigin: data?.publicOrigin ?? "https://chasesets.com",
    path: "/founders",
    title: t("publicPresence.routes.founders.meta.title"),
    description: t("publicPresence.routes.founders.meta.description"),
    imagePath: publicOpenGraphImages.founders,
  }),
];

export default function FoundersRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.founders.eyebrow"),
        title: t("publicPresence.info.founders.title"),
        description: t("publicPresence.info.founders.description"),
        sections: [
          {
            title: t("publicPresence.info.founders.offer.title"),
            body: [t("publicPresence.info.founders.offer.body")],
          },
          {
            title: t("publicPresence.info.founders.feeLock.title"),
            body: [t("publicPresence.info.founders.feeLock.body")],
          },
          {
            title: t("publicPresence.info.founders.buyerEconomics.title"),
            body: [t("publicPresence.info.founders.buyerEconomics.body")],
          },
          {
            title: t("publicPresence.info.founders.afterWindow.title"),
            body: [t("publicPresence.info.founders.afterWindow.body")],
          },
          {
            title: t("publicPresence.info.founders.faqForever.title"),
            body: [t("publicPresence.info.founders.faqForever.body")],
          },
          {
            title: t("publicPresence.info.founders.faqSignup.title"),
            body: [t("publicPresence.info.founders.faqSignup.body")],
          },
          {
            title: t("publicPresence.info.founders.faqKeep.title"),
            body: [t("publicPresence.info.founders.faqKeep.body")],
          },
        ],
      }}
    />
  );
}
