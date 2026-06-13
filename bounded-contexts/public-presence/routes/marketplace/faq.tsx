import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.faq.meta.title") },
  { name: "description", content: t("publicPresence.routes.faq.meta.description") },
];

export default function FaqRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.faq.eyebrow"),
        title: t("publicPresence.info.faq.title"),
        description: t("publicPresence.info.faq.description"),
        sections: [
          { title: t("publicPresence.faq.launch.question"), body: [t("publicPresence.faq.launch.answer")] },
          { title: t("publicPresence.faq.fees.question"), body: [t("publicPresence.faq.fees.answer")] },
          { title: t("publicPresence.faq.shipping.question"), body: [t("publicPresence.faq.shipping.answer")] },
          { title: t("publicPresence.faq.safety.question"), body: [t("publicPresence.faq.safety.answer")] },
        ],
      }}
    />
  );
}
