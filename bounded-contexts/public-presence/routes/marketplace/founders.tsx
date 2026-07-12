import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.founders.meta.title") },
  { name: "description", content: t("publicPresence.routes.founders.meta.description") },
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
